import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * The hiring team sees the assessment straight away. Judging blind first is
 * an option on the page, and an organisation can make it a requirement.
 */

const app = createApp();

const RESULT = {
  recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, overallScore: 70,
  competencies: [], strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

async function reviewerOnAssessment() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT) },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, assessmentId: assessment.id, auth };
}

async function requireBlind(tenantId: string, value: boolean) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: JSON.stringify({ requireBlindReview: value }) } });
}

beforeEach(async () => { await wipe(); });

describe('the assessment, straight away', () => {
  it('opens for a reviewer who has not judged blind when the organisation does not require it', async () => {
    const ids = await reviewerOnAssessment();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(res.status).toBe(200);
  });

  it('shows the scores', async () => {
    const ids = await reviewerOnAssessment();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(res.body.result.overallScore).toBe(70);
  });

  it('serves the full report as well', async () => {
    const ids = await reviewerOnAssessment();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/report?format=json`).set(ids.auth);
    expect(res.status).toBe(200);
  });

  it('keeps the blind review available as an option', async () => {
    const ids = await reviewerOnAssessment();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/blind`).set(ids.auth);
    expect(res.status).toBe(200);
  });
});

describe('when the organisation requires an independent review', () => {
  it('withholds the assessment until the reviewer judges blind', async () => {
    const ids = await reviewerOnAssessment();
    await requireBlind(ids.tenantId, true);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'blind_review_required' });
  });

  it('withholds the report too', async () => {
    const ids = await reviewerOnAssessment();
    await requireBlind(ids.tenantId, true);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/report`).set(ids.auth);
    expect(res.status).toBe(409);
  });

  it('opens once the reviewer has recorded a blind verdict', async () => {
    const ids = await reviewerOnAssessment();
    await requireBlind(ids.tenantId, true);
    await request(app).post(`/api/assessments/${ids.assessmentId}/blind-verdict`).set(ids.auth)
      .send({ disposition: 'CONSIDER', reason: 'My own read of the evidence.' });
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(res.status).toBe(200);
  });

  it('opens after a skip with a reason', async () => {
    const ids = await reviewerOnAssessment();
    await requireBlind(ids.tenantId, true);
    await request(app).post(`/api/assessments/${ids.assessmentId}/skip-blind-review`).set(ids.auth)
      .send({ reason: 'Re-reading a candidate we already decided on.' });
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(res.status).toBe(200);
  });

  it('opens again when the requirement is switched off', async () => {
    const ids = await reviewerOnAssessment();
    await requireBlind(ids.tenantId, false);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(res.status).toBe(200);
  });
});

describe('the admin switches', () => {
  it('saves both switches', async () => {
    const ids = await reviewerOnAssessment();
    const res = await request(app).put('/api/admin/policy').set(ids.auth)
      .send({ policy: { autoCandidateFeedback: false, requireBlindReview: true } });
    expect({ status: res.status, auto: res.body.policy.autoCandidateFeedback, blind: res.body.policy.requireBlindReview })
      .toEqual({ status: 200, auto: false, blind: true });
  });

  it('refuses a switch that is not a boolean', async () => {
    const ids = await reviewerOnAssessment();
    const res = await request(app).put('/api/admin/policy').set(ids.auth).send({ policy: { requireBlindReview: 'yes' } });
    expect(res.status).toBe(400);
  });

  it('leaves the reviewed feedback switch as it was', async () => {
    const ids = await reviewerOnAssessment();
    await request(app).put('/api/admin/policy').set(ids.auth).send({ policy: { candidateFeedbackEnabled: true } });
    const res = await request(app).put('/api/admin/policy').set(ids.auth).send({ policy: { autoCandidateFeedback: false } });
    expect(res.body.policy.candidateFeedbackEnabled).toBe(true);
  });
});
