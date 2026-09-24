import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import { DEFAULT_STAGES } from '../src/domain/pipelineStages.js';
import { humanReviewCheck } from '../src/services/humanReviewGate.js';

/**
 * The subject-matter expert advises; HR decides.
 *
 * That sentence is the whole reason this role exists as something other than a
 * second reviewer, and it is a property that would break silently: an SME
 * recommendation that quietly advanced a candidate would look, from every
 * screen in the product, exactly like HR having advanced them. Nobody would
 * report it. So it is pinned from three directions, because one of them alone
 * is a rule somebody can undo without noticing:
 *
 *  1. the stage stays where it was after a recommendation is recorded;
 *  2. the recommendation does not satisfy the Art. 22 human-review gate, so a
 *     decision that needed a real review still cannot be taken;
 *  3. the role holds none of the capabilities the moving routes are gated on.
 */

const app = createApp();

const FIXTURE_PASSPHRASE = 'not-a-real-passphrase-fixture';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let roleId = '';
let scorecardId = '';
let candidateId = '';
let sessionId = '';
let pipelineId = '';
let smeToken = '';
let smeUserId = '';
let secondSmeToken = '';
let secondSmeUserId = '';
let managerToken = '';

async function makeUser(role: string, email: string): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: { email, name: email, passwordHash: hashPassword(FIXTURE_PASSPHRASE), role, tenantId },
  });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

beforeAll(async () => {
  await wipe();

  const tenant = await prisma.tenant.create({ data: { name: 'Advisory Org' } });
  tenantId = tenant.id;
  const role = await prisma.role.create({ data: { tenantId, title: 'Principal Engineer', status: 'approved' } });
  roleId = role.id;
  const scorecard = await prisma.roleScorecardVersion.create({
    data: {
      roleId, version: 1, status: 'approved', approvedAt: new Date(),
      profileJson: JSON.stringify({ competencies: [{ id: 'c1', name: 'Systems design', definition: '', category: 'technical', classification: 'essential', weight: 1, requiredLevel: 'proficient', targetLevel: 'advanced', indicators: [], evidenceModes: [] }] }),
    },
  });
  scorecardId = scorecard.id;

  const candidate = await prisma.candidate.create({
    data: { tenantId, roleId, fullName: 'Arun Mehta', email: 'arun@advisory.test', emailNormalized: 'arun@advisory.test' },
  });
  candidateId = candidate.id;

  // A completed AI interview whose consent carries the promise, with an
  // assessment nobody has reviewed. This is the state the human-review gate is
  // meant to hold a decision back in.
  const session = await prisma.interviewSession.create({
    data: {
      tenantId, candidateId, roleId, scorecardId, state: 'COMPLETED',
      consentJson: JSON.stringify({ humanReviewRequired: true }),
    },
  });
  sessionId = session.id;
  await prisma.assessmentVersion.create({
    data: { sessionId: session.id, scorecardId, version: 1, resultJson: JSON.stringify({ overallScore: 71, recommendation: 'PROCEED', competencies: [], summary: 'Solid.', strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [] }) },
  });

  const pipeline = await prisma.candidatePipeline.create({
    data: {
      tenantId, candidateId, roleId,
      stagesJson: JSON.stringify(DEFAULT_STAGES), currentStageKey: 'silver', status: 'ACTIVE',
    },
  });
  pipelineId = pipeline.id;

  const sme = await makeUser('sme', 'expert@advisory.test');
  smeUserId = sme.id;
  smeToken = sme.token;
  const second = await makeUser('sme', 'expert2@advisory.test');
  secondSmeUserId = second.id;
  secondSmeToken = second.token;
  const manager = await makeUser('manager', 'manager@advisory.test');
  managerToken = manager.token;
  // The manager works the requisition, which is how they reach the candidate.
  // Without it every assertion below would fail on scope rather than on the
  // thing it is about.
  await prisma.roleAssignment.create({ data: { roleId, userId: manager.id, relation: 'owner' } });

  await prisma.candidateAssignment.createMany({
    data: [
      { candidateId, userId: smeUserId, relation: 'sme' },
      { candidateId, userId: secondSmeUserId, relation: 'sme' },
    ],
  });
});

beforeEach(async () => {
  await prisma.smeReview.deleteMany({ where: { candidateId } });
  await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { currentStageKey: 'silver', status: 'ACTIVE', decision: null } });
});

const recommend = (token: string, body: Record<string, unknown>) => request(app)
  .put(`/api/sme/candidates/${candidateId}/review`).set(auth(token)).send(body);

const PROCEED = { recommendation: 'proceed', feedback: 'Reasoned about partial failure before being asked to, which is the bar here.' };

describe('recording a recommendation', () => {
  it('stores it against the expert who wrote it', async () => {
    const res = await recommend(smeToken, PROCEED);

    expect(res.status).toBe(201);
    const stored = await prisma.smeReview.findFirstOrThrow({ where: { candidateId, smeUserId } });
    expect(stored.recommendation).toBe('proceed');
  });

  // The reasoning is the part the hiring team cannot get anywhere else: a bare
  // "Proceed" says only the what, and the whole point of asking an expert is
  // learning where they and the machine read the same person differently.
  it('refuses a recommendation with no argument behind it', async () => {
    const res = await recommend(smeToken, { recommendation: 'proceed', feedback: 'Good.' });

    expect(res.status).toBe(400);
  });

  it('refuses a recommendation outside the two words', async () => {
    const res = await recommend(smeToken, { ...PROCEED, recommendation: 'CONSIDER' });

    expect(res.status).toBe(400);
  });

  // The verdict vocabulary belongs to a review the pipeline acts on. Accepting
  // it here would be the first step towards the two meaning the same thing.
  it('refuses the reviewer\'s verdict vocabulary', async () => {
    const res = await recommend(smeToken, { ...PROCEED, recommendation: 'PROCEED' });

    expect(res.status).toBe(400);
  });

  // A second submit revises the first. Without the unique constraint two
  // presses would leave HR looking at one expert recommending both ways, with
  // no way to tell which they meant.
  it('revises in place rather than recording a second opinion from the same expert', async () => {
    await recommend(smeToken, PROCEED);
    const again = await recommend(smeToken, { recommendation: 'do_not_proceed', feedback: 'On a second reading the design answers were recited rather than reasoned.' });

    expect(again.status).toBe(200);
    const rows = await prisma.smeReview.findMany({ where: { candidateId, smeUserId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].recommendation).toBe('do_not_proceed');
  });

  it('keeps two experts\' recommendations apart', async () => {
    await recommend(smeToken, PROCEED);
    await recommend(secondSmeToken, { recommendation: 'do_not_proceed', feedback: 'The depth was not there on the second competency at all.' });

    expect(await prisma.smeReview.count({ where: { candidateId } })).toBe(2);
  });

  it('refuses to attach a recommendation to another candidate\'s interview', async () => {
    const other = await prisma.candidate.create({
      data: { tenantId, roleId, fullName: 'Not Theirs', email: 'nt@advisory.test', emailNormalized: 'nt@advisory.test' },
    });
    const theirSession = await prisma.interviewSession.create({
      data: { tenantId, candidateId: other.id, roleId, scorecardId, state: 'COMPLETED', consentJson: '{}' },
    });

    const res = await recommend(smeToken, { ...PROCEED, sessionId: theirSession.id });

    expect(res.status).toBe(404);
  });

  it('refuses an expert who is not assigned this candidate', async () => {
    const stranger = await makeUser('sme', 'stranger@advisory.test');

    expect((await recommend(stranger.token, PROCEED)).status).toBe(404);
  });
});

describe('the worklist tick', () => {
  // The tick means "you have read this person for the role they are up for".
  // Keyed on the candidate alone it would also mean "for some role, once" —
  // and an expert who trusts it would skip somebody nobody has read for the
  // job they are actually being considered for.
  it('does not mark a candidate read when the reading was for a different role', async () => {
    await recommend(smeToken, PROCEED);
    const otherRole = await prisma.role.create({ data: { tenantId, title: 'A Different Job', status: 'approved' } });
    await prisma.candidate.update({ where: { id: candidateId }, data: { roleId: otherRole.id } });

    const res = await request(app).get('/api/sme/assignments').set(auth(smeToken));

    expect(res.body.assignments.find((a: { candidateId: string }) => a.candidateId === candidateId).review).toBeNull();

    await prisma.candidate.update({ where: { id: candidateId }, data: { roleId } });
  });

  it('marks it read when the reading was for the role they are up for', async () => {
    await recommend(smeToken, PROCEED);

    const res = await request(app).get('/api/sme/assignments').set(auth(smeToken));

    expect(res.body.assignments.find((a: { candidateId: string }) => a.candidateId === candidateId).review.recommendation).toBe('proceed');
  });
});

describe('an expert reads only their own recommendation', () => {
  it('is shown their own', async () => {
    await recommend(smeToken, PROCEED);

    const res = await request(app).get(`/api/sme/candidates/${candidateId}`).set(auth(smeToken));

    expect(res.body.review.recommendation).toBe('proceed');
  });

  // Two experts on the same candidate is the point of asking two. Letting the
  // second read the first would make the second a countersignature rather than
  // an independent reading, and the difference is invisible afterwards.
  it('is not shown another expert\'s, on the same candidate', async () => {
    await recommend(secondSmeToken, { recommendation: 'do_not_proceed', feedback: 'Recited the pattern without ever naming the trade-off it costs.' });

    const res = await request(app).get(`/api/sme/candidates/${candidateId}`).set(auth(smeToken));

    expect(res.body.review).toBeFalsy();
    expect(JSON.stringify(res.body)).not.toContain('Recited the pattern');
  });
});

describe('the recommendation moves nobody', () => {
  it('leaves the candidate at the stage they were at', async () => {
    const before = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipelineId } });

    await recommend(smeToken, PROCEED);

    const after = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    expect([after.currentStageKey, after.status, after.decision])
      .toEqual([before.currentStageKey, before.status, before.decision]);
  });

  it('leaves the candidate where they were on a negative recommendation too', async () => {
    await recommend(smeToken, { recommendation: 'do_not_proceed', feedback: 'Two of the three essential competencies had no evidence at all behind them.' });

    const after = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipelineId } });
    expect([after.currentStageKey, after.status]).toEqual(['silver', 'ACTIVE']);
  });

  // The sharpest of the three. A recommendation that satisfied this gate would
  // let a decision be taken on a candidate no person had reviewed, while the
  // consent screen said one would — and the audit trail would show the promise
  // kept.
  it('does not satisfy the human-review gate the consent screen promised', async () => {
    const before = await humanReviewCheck({ tenantId, candidateId, roleId });
    expect(before.missing).not.toBeNull();

    await recommend(smeToken, PROCEED);

    const after = await humanReviewCheck({ tenantId, candidateId, roleId });
    expect(after.missing).not.toBeNull();
  });

  it('writes no HumanReview', async () => {
    await recommend(smeToken, PROCEED);

    expect(await prisma.humanReview.count()).toBe(0);
  });

  it('is still refused a decision after recommending, because the gate is unmet', async () => {
    await recommend(smeToken, PROCEED);

    const res = await request(app).post(`/api/pipelines/${pipelineId}/decision`).set(auth(managerToken))
      .send({ stageKey: 'silver', decision: 'APPROVED', reason: 'The expert was content with the depth.' });

    expect(res.status).toBe(409);
  });
});

describe('the expert holds none of the capabilities that move a candidate', () => {
  // One case per moving route rather than a loop, so a failure names the one
  // that regressed. Each is gated on a capability the `sme` role deliberately
  // does not hold (domain/capabilities.ts).
  it('cannot advance a pipeline (interview:create)', async () => {
    const res = await request(app).post(`/api/pipelines/${pipelineId}/advance`).set(auth(smeToken)).send({ toStageKey: 'gold' });

    expect(res.status).toBe(403);
  });

  it('cannot record a pipeline decision (assessment:review)', async () => {
    const res = await request(app).post(`/api/pipelines/${pipelineId}/decision`).set(auth(smeToken))
      .send({ stageKey: 'silver', decision: 'APPROVED', reason: 'Because I said so, at length.' });

    expect(res.status).toBe(403);
  });

  it('cannot finalise a candidate (assessment:review)', async () => {
    expect((await request(app).post(`/api/pipelines/${pipelineId}/finalize`).set(auth(smeToken)).send({})).status).toBe(403);
  });

  it('cannot schedule a round (interview:schedule)', async () => {
    const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set(auth(smeToken)).send({ stageKey: 'gold' });

    expect(res.status).toBe(403);
  });

  it('cannot submit a HumanReview (assessment:review)', async () => {
    const assessment = await prisma.assessmentVersion.findFirstOrThrow({ where: { sessionId } });

    const res = await request(app).post(`/api/assessments/${assessment.id}/review`).set(auth(smeToken))
      .send({ disposition: 'PROCEED', reason: 'A reason long enough to pass the schema.' });

    expect(res.status).toBe(403);
  });
});

describe('the hiring team sees the recommendation', () => {
  it('shows a manager who recommended what, by name', async () => {
    await recommend(smeToken, PROCEED);

    const res = await request(app).get(`/api/candidates/${candidateId}/sme`).set(auth(managerToken));

    expect(res.status).toBe(200);
    expect(res.body.reviews[0].sme.name).toBe('expert@advisory.test');
    expect(res.body.reviews[0].recommendationLabel).toBe('Proceed');
  });

  // The team has to be able to tell "asked, nothing back yet" from "nobody was
  // asked". They look identical if only the answers are listed.
  it('names the experts who have been asked and have not answered', async () => {
    await recommend(smeToken, PROCEED);

    const res = await request(app).get(`/api/candidates/${candidateId}/sme`).set(auth(managerToken));

    expect(res.body.awaiting.map((a: { userId: string }) => a.userId)).toEqual([secondSmeUserId]);
  });

  // The advisory note travels with the recommendation rather than being written
  // into each page, so no surface can show a recommendation without it.
  it('says plainly that a recommendation moves nobody', async () => {
    const res = await request(app).get(`/api/candidates/${candidateId}/sme`).set(auth(managerToken));

    expect(res.body.note).toContain('moves nobody');
  });

  it('refuses an expert the hiring team\'s view of the same candidate', async () => {
    expect((await request(app).get(`/api/candidates/${candidateId}/sme`).set(auth(smeToken))).status).toBe(403);
  });

  // The recommendation is the record of advice the team may have weighed.
  // Withdrawing a permission must not rewrite it.
  it('keeps a recommendation after its author is unassigned', async () => {
    await recommend(smeToken, PROCEED);
    await request(app).delete(`/api/candidates/${candidateId}/sme/${smeUserId}`).set(auth(managerToken));

    const res = await request(app).get(`/api/candidates/${candidateId}/sme`).set(auth(managerToken));
    expect(res.body.reviews).toHaveLength(1);

    await prisma.candidateAssignment.create({ data: { candidateId, userId: smeUserId, relation: 'sme' } });
  });
});
