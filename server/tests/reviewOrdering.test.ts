import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { reviewOrdering, orderingView } from '../src/domain/reviewOrdering.js';

/**
 * Whether the human review was recorded before or after the AI's reading was
 * visible — stored on the review, not inferred afterwards.
 *
 * The same verdict, by the same reviewer, at the same minute, means two
 * different things depending on that ordering, and the page says which. So the
 * fact has to survive a pruned audit log and a changed policy, which means it
 * has to be a column.
 */

const app = createApp();

const RESULT = {
  recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, overallScore: 74,
  competencies: [], strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

async function assessmentForReviewer() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT) },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, assessmentId: assessment.id, auth };
}

/**
 * The transcript requirement the verdict now passes through
 * (services/transcriptReadGate.ts). These tests are about which reading came
 * first, not about how the transcript was read, so they take the audited
 * "read it elsewhere" route: it needs no turns and leaves the same record.
 */
const readTranscript = (assessmentId: string, auth: Record<string, string>) =>
  request(app).post(`/api/assessments/${assessmentId}/transcript-read`).set(auth)
    .send({ method: 'elsewhere', attestation: 'Read the exported transcript before opening this page.' });

const recordVerdict = async (assessmentId: string, auth: Record<string, string>) => {
  await readTranscript(assessmentId, auth);
  return request(app).post(`/api/assessments/${assessmentId}/review`).set(auth)
    .send({ verdict: 'PROCEED', reason: 'He gave the whole diagnosis at 18:40. That is a 4, not a 2.' });
};

beforeEach(async () => { await wipe(); });

describe('a verdict recorded after the AI\'s reading was on screen', () => {
  it('is recorded as ai_first', async () => {
    const ids = await assessmentForReviewer();
    await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    await recordVerdict(ids.assessmentId, ids.auth);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(res.body.reviewed.review.ordering.kind).toBe('ai_first');
  });

  it('is what a reviewer who never opened anything gets too, because independence is never assumed', async () => {
    const ids = await assessmentForReviewer();
    await recordVerdict(ids.assessmentId, ids.auth);
    const review = await prisma.humanReview.findFirst({ where: { assessmentId: ids.assessmentId, status: 'COMPLETED' } });
    expect(review?.aiVisibleBefore).toBe(true);
  });
});

describe('a verdict recorded blind first', () => {
  it('is recorded as blind_first, and stays so after the AI is revealed', async () => {
    const ids = await assessmentForReviewer();
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ requireBlindReview: true }) } });
    await request(app).post(`/api/assessments/${ids.assessmentId}/blind-verdict`).set(ids.auth)
      .send({ verdict: 'CONSIDER', reason: 'My own read of the evidence, before seeing theirs.' });
    // Opening the assessment is what reveals the AI; the blind judgement came first.
    await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    await recordVerdict(ids.assessmentId, ids.auth);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(res.body.reviewed.review.ordering.kind).toBe('blind_first');
  });
});

describe('the ordering vocabulary', () => {
  it('never guesses an ordering for a review recorded before the fact was stored', () => {
    expect(reviewOrdering(null)).toBe('unknown');
    expect(reviewOrdering(undefined)).toBe('unknown');
    expect(orderingView('unknown').label).toContain('not recorded');
  });

  it('says which came first in words, not only in a flag', () => {
    expect(orderingView('blind_first').label).toContain('before');
    expect(orderingView('ai_first').label).toContain('after');
  });
});

describe('when the AI produced its reading', () => {
  it('is on the assessment, so the two parts can each say when they were recorded', async () => {
    const ids = await assessmentForReviewer();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);
    expect(typeof res.body.scoredAt).toBe('string');
  });
});
