import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';
import { SELF_REVIEW_NOTE } from '../src/services/shadowMode.js';

// Object-level authorization on the interview and assessment routes.
//
// These routes previously filtered on tenantId alone, which meant "logged in at
// this company" was the only thing standing between a recruiter and every other
// recruiter's candidates — their transcripts, their invitation links, and the
// ability to write turns into a transcript that backs a hiring decision.
//
// Fixtures are built directly against Prisma rather than driven through the API,
// because the point of these tests is who may touch an object, not how the
// object came to exist. Driving a real interview through the engine would make
// them slow and would couple them to the scoring pipeline.

const app = createApp();

interface Fixture {
  readonly tenantId: string;
  readonly recruiterAToken: string;
  readonly recruiterBToken: string;
  readonly managerToken: string;
  readonly selfReviewingManagerToken: string;
  readonly sessionId: string;
  readonly assessmentId: string;
  readonly selfReviewAssessmentId: string;
}

let fx: Fixture;
let selfReviewStatus = 0;

async function makeUser(tenantId: string, email: string, role: string) {
  const user = await prisma.user.create({
    data: { tenantId, email, name: email, passwordHash: 'x', role },
  });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

/** A session + assessment for `candidateId`, with `droverId` recorded as having driven it. */
async function makeInterview(
  tenantId: string,
  roleId: string,
  scorecardId: string,
  candidateId: string,
  droverId: string,
) {
  const session = await prisma.interviewSession.create({
    data: { tenantId, candidateId, roleId, scorecardId, state: 'REVIEW_READY' },
  });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: session.id,
      scorecardId,
      recommendation: 'CONSIDER',
      resultJson: JSON.stringify({ recommendation: 'CONSIDER', competencies: [] }),
    },
  });
  // ranTheInterview() reads the audit trail, so this is what "drove it" means.
  await prisma.auditEvent.create({
    data: {
      tenantId,
      actorId: droverId,
      actorType: 'user',
      action: 'interview.started.by_recruiter',
      entityType: 'InterviewSession',
      entityId: session.id,
    },
  });
  return { sessionId: session.id, assessmentId: assessment.id };
}

beforeAll(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Access Org' } });
  const tenantId = tenant.id;

  const recruiterA = await makeUser(tenantId, 'a@access.local', 'recruiter');
  const recruiterB = await makeUser(tenantId, 'b@access.local', 'recruiter');
  const manager = await makeUser(tenantId, 'm@access.local', 'manager');
  const selfManager = await makeUser(tenantId, 'selfm@access.local', 'manager');

  const role = await prisma.role.create({ data: { tenantId, title: 'Data Engineer', status: 'approved' } });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, status: 'approved', profileJson: JSON.stringify({ competencies: [] }) },
  });

  // Candidate 1: recruiter A owns it, the manager reviews it.
  const candidate = await prisma.candidate.create({
    data: { tenantId, roleId: role.id, fullName: 'Priya Sharma', email: 'priya@e.com' },
  });
  await prisma.candidateAssignment.createMany({
    data: [
      { candidateId: candidate.id, userId: recruiterA.id, relation: 'owner' },
      { candidateId: candidate.id, userId: manager.id, relation: 'reviewer' },
    ],
  });
  const one = await makeInterview(tenantId, role.id, scorecard.id, candidate.id, recruiterA.id);

  // Candidate 2: the same manager both drove the interview and will review it.
  const candidate2 = await prisma.candidate.create({
    data: { tenantId, roleId: role.id, fullName: 'Sam Okafor', email: 'sam@e.com' },
  });
  await prisma.candidateAssignment.create({
    data: { candidateId: candidate2.id, userId: selfManager.id, relation: 'owner' },
  });
  const two = await makeInterview(tenantId, role.id, scorecard.id, candidate2.id, selfManager.id);

  fx = {
    tenantId,
    recruiterAToken: recruiterA.token,
    recruiterBToken: recruiterB.token,
    managerToken: manager.token,
    selfReviewingManagerToken: selfManager.token,
    sessionId: one.sessionId,
    assessmentId: one.assessmentId,
    selfReviewAssessmentId: two.assessmentId,
  };
});

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('interview object scope', () => {
  it('lets the assigned recruiter read their own interview', async () => {
    const res = await request(app).get(`/api/interviews/${fx.sessionId}`).set(as(fx.recruiterAToken));
    expect(res.status).toBe(200);
  });

  it("hides another recruiter's interview behind a 404, not a 403", async () => {
    // 404 rather than 403 on purpose: a 403 confirms the id exists, which is
    // itself a disclosure about a candidate the caller may not know about.
    const res = await request(app).get(`/api/interviews/${fx.sessionId}`).set(as(fx.recruiterBToken));
    expect(res.status).toBe(404);
  });

  it("does not leak the invitation token to an unassigned recruiter", async () => {
    const res = await request(app).get(`/api/interviews/${fx.sessionId}`).set(as(fx.recruiterBToken));
    expect(res.body.invitation).toBeUndefined();
  });

  it("omits another recruiter's interview from the list", async () => {
    const res = await request(app).get('/api/interviews').set(as(fx.recruiterBToken));
    expect(res.body.sessions).toHaveLength(0);
  });

  it('includes the assigned recruiter\'s own interview in the list', async () => {
    const res = await request(app).get('/api/interviews').set(as(fx.recruiterAToken));
    expect(res.body.sessions).toHaveLength(1);
  });

  it("refuses to let another recruiter write a turn into the transcript", async () => {
    // The capability check passes here — recruiter B genuinely holds
    // interview:drive. Only object scope stops them, which is exactly the hole
    // a capability-only fix would have left open.
    const res = await request(app)
      .post(`/api/interviews/${fx.sessionId}/turn`)
      .set(as(fx.recruiterBToken))
      .send({ text: 'Injected turn from an unrelated recruiter.' });
    expect(res.status).toBe(404);
  });

  it("refuses to let another recruiter start the interview", async () => {
    const res = await request(app)
      .post(`/api/interviews/${fx.sessionId}/start`)
      .set(as(fx.recruiterBToken))
      .send({});
    expect(res.status).toBe(404);
  });

  it("refuses to let another recruiter read the transcript", async () => {
    const res = await request(app).get(`/api/interviews/${fx.sessionId}/transcript`).set(as(fx.recruiterBToken));
    expect(res.status).toBe(404);
  });

  it("refuses to let another recruiter cancel the interview", async () => {
    const res = await request(app).post(`/api/interviews/${fx.sessionId}/cancel`).set(as(fx.recruiterBToken)).send({});
    expect(res.status).toBe(404);
  });
});

describe('assessment review capability', () => {
  it('lets an assigned recruiter read the assessment', async () => {
    const res = await request(app).get(`/api/assessments/${fx.assessmentId}`).set(as(fx.recruiterAToken));
    expect(res.status).toBe(200);
  });

  it('refuses to let a recruiter sign off an assessment', async () => {
    // 403, not 404: the recruiter may legitimately see this assessment, so
    // there is nothing to hide — they simply lack assessment:review. The
    // recruiter role deliberately cannot approve the outcome it produced.
    const res = await request(app)
      .post(`/api/assessments/${fx.assessmentId}/review`)
      .set(as(fx.recruiterAToken))
      .send({ disposition: 'PROCEED', reason: 'Looks strong to me.' });
    expect(res.status).toBe(403);
  });

  it("refuses to let a recruiter read another recruiter's assessment", async () => {
    const res = await request(app).get(`/api/assessments/${fx.assessmentId}`).set(as(fx.recruiterBToken));
    expect(res.status).toBe(404);
  });

  it('refuses to let a recruiter export an assessment to the ATS', async () => {
    const res = await request(app)
      .post(`/api/assessments/${fx.assessmentId}/export`)
      .set(as(fx.recruiterAToken))
      .send({});
    expect(res.status).toBe(403);
  });

  it('lets an assigned manager sign off the assessment', async () => {
    const res = await request(app)
      .post(`/api/assessments/${fx.assessmentId}/review`)
      .set(as(fx.managerToken))
      .send({ disposition: 'CONSIDER', reason: 'Want a second panel on leadership scope.' });
    expect(res.status).toBe(201);
  });

  it('does not flag a manager reviewing an interview they did not run', async () => {
    const review = await prisma.humanReview.findFirst({
      where: { assessmentId: fx.assessmentId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(review?.comments).not.toContain(SELF_REVIEW_NOTE);
  });
});

describe('separation of duties (soft)', () => {
  // Shared across this block so the flag on the HTTP response and the flag
  // persisted to the record can each be asserted on their own.
  let selfReviewBody: { review?: { selfReview?: boolean } } = {};

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/assessments/${fx.selfReviewAssessmentId}/review`)
      .set(as(fx.selfReviewingManagerToken))
      .send({ disposition: 'PROCEED', reason: 'No second reviewer available this week.' });
    selfReviewStatus = res.status;
    selfReviewBody = res.body;
  });

  it('allows a reviewer to sign off the interview they personally ran', async () => {
    // Deliberately not blocked. A small team may have nobody else available,
    // and a hard 403 here produces a shared admin login rather than an
    // independent reviewer — losing the audit trail along with the independence.
    expect(selfReviewStatus).toBe(201);
  });

  it('reports the self-review back to the caller', async () => {
    expect(selfReviewBody.review?.selfReview).toBe(true);
  });

  it('stamps the lack of independence onto the review record', async () => {
    const review = await prisma.humanReview.findFirst({
      where: { assessmentId: fx.selfReviewAssessmentId },
    });
    expect(review?.comments).toContain(SELF_REVIEW_NOTE);
  });

  it('preserves the reviewer\'s own comment alongside the marker', async () => {
    const review = await prisma.humanReview.findFirst({
      where: { assessmentId: fx.selfReviewAssessmentId },
    });
    expect(review?.reason).toBe('No second reviewer available this week.');
  });

  it('records the self-review flag in the audit trail', async () => {
    // The compliance record is the point: a later audit must be able to find
    // non-independent reviews without reparsing free-text comments.
    const event = await prisma.auditEvent.findFirst({
      where: { action: 'review.completed', entityId: fx.selfReviewAssessmentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(event?.afterJson ?? '{}').selfReview).toBe(true);
  });
});
