import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * What the assessment page needs for its three tabs: the AI's own output, the
 * version a reviewer left, and the difference between them — the record the
 * AI is meant to learn from. All of it derived from the review already stored,
 * so nothing is written twice.
 */

const app = createApp();

const RESULT = {
  assessmentVersion: 'A', roleScorecardVersion: 's', recommendation: 'PROCEED', confidence: 0.8,
  evidenceCoverage: 0.7, overallScore: 82,
  competencies: [
    { id: 'sql', name: 'SQL', level: 4, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false, rationale: '', rubricVersion: 'r', evidence: [] },
    { id: 'stake', name: 'Stakeholder management', level: 2, requiredLevel: 3, confidence: 0.7, notEnoughEvidence: false, rationale: '', rubricVersion: 'r', evidence: [] },
  ],
  strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

async function assessment() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
  const created = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'PROCEED',
      confidence: 0.8, evidenceCoverage: 0.7, resultJson: JSON.stringify(RESULT),
    },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, assessmentId: created.id, auth };
}

const OVERRIDES = [{ competencyId: 'stake', from: 2, to: 4, reason: 'Much stronger in the second half than the transcript reads.' }];

async function review(ids: Awaited<ReturnType<typeof assessment>>, disposition = 'CONSIDER') {
  const res = await request(app).post(`/api/assessments/${ids.assessmentId}/review`).set(ids.auth)
    .send({ disposition, reason: 'My own read of the evidence.', comments: 'Worth a second conversation.', overrides: OVERRIDES });
  expect(res.status).toBe(201);
}

const load = (ids: Awaited<ReturnType<typeof assessment>>) =>
  request(app).get(`/api/assessments/${ids.assessmentId}`).set(ids.auth);

beforeEach(async () => { await wipe(); });

describe('before anyone has reviewed it', () => {
  it('has no reviewed version', async () => {
    expect((await load(await assessment())).body.reviewed).toBeNull();
  });

  it('has nothing to compare', async () => {
    expect((await load(await assessment())).body.differences).toBeNull();
  });

  it("reports the AI's own recommendation as the outcome", async () => {
    expect((await load(await assessment())).body.outcome).toMatchObject({ source: 'ai', recommendation: 'PROCEED' });
  });
});

describe('once a reviewer has been through it', () => {
  it("keeps the AI's own output exactly as it was", async () => {
    const ids = await assessment();
    await review(ids);
    const body = (await load(ids)).body;
    expect({ recommendation: body.result.recommendation, level: body.result.competencies[1].level, score: body.result.overallScore })
      .toEqual({ recommendation: 'PROCEED', level: 2, score: 82 });
  });

  it("shows the reviewer's own levels in the reviewed version", async () => {
    const ids = await assessment();
    await review(ids);
    const reviewed = (await load(ids)).body.reviewed;
    expect(reviewed.result.competencies.find((c: { id: string }) => c.id === 'stake').level).toBe(4);
  });

  it("takes the reviewer's disposition as the recommendation", async () => {
    const ids = await assessment();
    await review(ids);
    expect((await load(ids)).body.reviewed.result.recommendation).toBe('CONSIDER');
  });

  it('carries the reviewer, their reason and their comments', async () => {
    const ids = await assessment();
    await review(ids);
    expect((await load(ids)).body.reviewed.review).toMatchObject({
      disposition: 'CONSIDER', reason: 'My own read of the evidence.', comments: 'Worth a second conversation.', reviewerId: ids.userId,
    });
  });

  it('is what the rest of the product reports as the outcome', async () => {
    const ids = await assessment();
    await review(ids);
    expect((await load(ids)).body.outcome).toMatchObject({ source: 'human', recommendation: 'CONSIDER' });
  });

  it('lists what the reviewer changed, with both readings and their reason', async () => {
    const ids = await assessment();
    await review(ids);
    const changed = (await load(ids)).body.differences.competencies.filter((c: { changed: boolean }) => c.changed);
    expect(changed).toEqual([{
      competencyId: 'stake', competencyName: 'Stakeholder management', aiLevel: 2, humanLevel: 4,
      changed: true, reason: OVERRIDES[0].reason,
    }]);
  });

  it('compares the two verdicts', async () => {
    const ids = await assessment();
    await review(ids);
    expect((await load(ids)).body.differences.disposition).toEqual({ ai: 'PROCEED', human: 'CONSIDER', agreed: false });
  });

  it('sums the agreement up in a line', async () => {
    const ids = await assessment();
    await review(ids);
    expect((await load(ids)).body.differences.summary).toContain('changed 1 of 2 competency levels');
  });

  it('says so when the reviewer agreed with the AI', async () => {
    const ids = await assessment();
    await review(ids, 'PROCEED');
    expect((await load(ids)).body.differences.disposition.agreed).toBe(true);
  });
});
