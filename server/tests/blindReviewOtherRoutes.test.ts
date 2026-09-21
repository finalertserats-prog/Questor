import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * When an organisation requires an independent review, the AI's call is
 * withheld from a reviewer until they judge blind. GET /api/assessments/:id
 * enforced that, but the interview list, the interview page and the pipeline
 * summary handed the same recommendation (and on the interview page the full
 * scores) to the same reviewer.
 */

const app = createApp();

const RESULT = {
  recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, overallScore: 70,
  competencies: [], strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

async function assessedInterview() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT) },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, assessmentId: assessment.id, auth };
}

async function requireBlind(tenantId: string) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: JSON.stringify({ requireBlindReview: true }) } });
}

async function recruiterAuth(ids: Awaited<ReturnType<typeof assessedInterview>>) {
  const user = await prisma.user.create({ data: { tenantId: ids.tenantId, email: 'recruiter@blind.test', name: 'Recruiter', passwordHash: 'x', role: 'recruiter' } });
  await prisma.roleAssignment.create({ data: { userId: user.id, roleId: ids.roleId } });
  return { Authorization: `Bearer ${signToken({ userId: user.id, tenantId: ids.tenantId, role: 'recruiter', email: user.email })}` };
}

async function listRow(auth: Record<string, string>, sessionId: string) {
  const res = await request(app).get('/api/interviews').set(auth);
  return (res.body.sessions as Array<Record<string, unknown>>).find((s) => s.id === sessionId);
}

async function silverPipeline(ids: Awaited<ReturnType<typeof assessedInterview>>) {
  const id = (await request(app).post('/api/pipelines').set(ids.auth).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
  for (const key of ['bronze', 'silver']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set(ids.auth).send({ toStageKey: key });
  }
  // The interview has already been held, so its round is recorded in the past:
  // a future time would ask to move a finished interview, which is refused.
  await request(app).post(`/api/pipelines/${id}/rounds`).set(ids.auth)
    .send({ stageKey: 'silver', scheduledAt: new Date(Date.now() - 86_400_000).toISOString(), sessionId: ids.sessionId });
  return id;
}

async function silverDetail(auth: Record<string, string>, pipelineId: string) {
  const res = await request(app).get(`/api/pipelines/${pipelineId}/summary`).set(auth);
  return (res.body.summary.stages as Array<{ key: string; detail: string }>).find((s) => s.key === 'silver')?.detail;
}

beforeEach(async () => { await wipe(); });

describe('a reviewer who has not judged blind, in an organisation that requires it', () => {
  it('gets no recommendation on the interview list', async () => {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    const row = await listRow(ids.auth, ids.sessionId);
    expect(row?.recommendation).toBeUndefined();
  });

  it('gets no colleague verdict on the interview list either', async () => {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    const colleague = await prisma.user.create({ data: { tenantId: ids.tenantId, email: 'colleague@blind.test', name: 'Colleague', passwordHash: 'x', role: 'reviewer' } });
    await prisma.humanReview.create({ data: { assessmentId: ids.assessmentId, reviewerId: colleague.id, status: 'COMPLETED', disposition: 'PROCEED', completedAt: new Date() } });
    const row = await listRow(ids.auth, ids.sessionId);
    expect(row?.humanRecommendation).toBeUndefined();
  });

  it('is told on the interview list that their review comes first', async () => {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    const row = await listRow(ids.auth, ids.sessionId);
    expect(row?.blindReviewPending).toBe(true);
  });

  it('still gets the assessment id on the interview list, to reach the blind review', async () => {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    const row = await listRow(ids.auth, ids.sessionId);
    expect(row?.assessmentId).toBe(ids.assessmentId);
  });

  it('gets neither the recommendation nor the scores on the interview page', async () => {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(res.body.assessment).toEqual({ id: ids.assessmentId, blindReviewPending: true });
  });

  it('does not see the AI call in the pipeline summary', async () => {
    const ids = await assessedInterview();
    const pipelineId = await silverPipeline(ids);
    await requireBlind(ids.tenantId);
    expect(await silverDetail(ids.auth, pipelineId)).not.toContain('CONSIDER');
  });

  it('still sees that the AI interview was assessed in the pipeline summary', async () => {
    const ids = await assessedInterview();
    const pipelineId = await silverPipeline(ids);
    await requireBlind(ids.tenantId);
    const res = await request(app).get(`/api/pipelines/${pipelineId}/summary`).set(ids.auth);
    expect(res.body.summary.missingEvidence).not.toContain('Silver');
  });
});

describe('the same reviewer after judging blind', () => {
  async function judged() {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    await request(app).post(`/api/assessments/${ids.assessmentId}/blind-verdict`).set(ids.auth)
      .send({ disposition: 'CONSIDER', reason: 'My own read of the evidence.' });
    return ids;
  }

  it('sees the recommendation on the interview list', async () => {
    const ids = await judged();
    expect((await listRow(ids.auth, ids.sessionId))?.recommendation).toBe('CONSIDER');
  });

  it('sees the scores on the interview page', async () => {
    const ids = await judged();
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(res.body.assessment.result.overallScore).toBe(70);
  });

  it('sees the AI call in the pipeline summary', async () => {
    const ids = await judged();
    const pipelineId = await silverPipeline(ids);
    expect(await silverDetail(ids.auth, pipelineId)).toContain('CONSIDER');
  });
});

describe('a reviewer who skipped the blind review with a reason', () => {
  it('sees the recommendation on the interview list', async () => {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    await request(app).post(`/api/assessments/${ids.assessmentId}/skip-blind-review`).set(ids.auth)
      .send({ reason: 'Re-reading a candidate we already decided on.' });
    expect((await listRow(ids.auth, ids.sessionId))?.recommendation).toBe('CONSIDER');
  });
});

describe('when the organisation does not require it', () => {
  it('shows the reviewer the recommendation on the interview list', async () => {
    const ids = await assessedInterview();
    expect((await listRow(ids.auth, ids.sessionId))?.recommendation).toBe('CONSIDER');
  });

  it('shows the scores on the interview page', async () => {
    const ids = await assessedInterview();
    const res = await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(res.body.assessment.result.overallScore).toBe(70);
  });

  it('records the interview page as an unblinded read, as the assessment page does', async () => {
    const ids = await assessedInterview();
    await request(app).get(`/api/interviews/${ids.sessionId}`).set(ids.auth);
    expect(await prisma.auditEvent.count({ where: { action: 'assessment.ai_viewed_without_blind_verdict', entityId: ids.assessmentId } })).toBe(1);
  });
});

describe('someone who reads assessments but does not review them', () => {
  it('sees the recommendation even when the organisation requires blind review', async () => {
    const ids = await assessedInterview();
    await requireBlind(ids.tenantId);
    const recruiter = await recruiterAuth(ids);
    expect((await listRow(recruiter, ids.sessionId))?.recommendation).toBe('CONSIDER');
  });
});
