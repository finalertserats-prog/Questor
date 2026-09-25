import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { sweepIncompleteInterviews, INACTIVITY_MS } from '../src/services/incompleteInterviews.js';
import { assertTransition } from '../src/domain/stateMachine.js';
import { HttpError } from '../src/middleware/index.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';

/**
 * Guards on the recruiter-side interview lifecycle routes.
 *
 * Each of these used to either 500 (an illegal transition thrown as a plain
 * Error) or quietly act on a session in a state where the action means nothing
 * — resending a dead link, scheduling a cancelled interview.
 */

const app = createApp();

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;
let adminToken = '';
const auth = () => ({ Authorization: `Bearer ${adminToken}` });

beforeEach(async () => {
  await wipe();
  demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  adminToken = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
});

async function sessionIn(state: string) {
  return prisma.interviewSession.create({
    data: { tenantId: demo.tenantId, candidateId: demo.candidateId, roleId: demo.roleId, scorecardId: demo.scorecardId, state },
  });
}

const ANSWERS = [
  'I led the payments platform team for four years and owned the ledger service end to end.',
  'The hardest problem was reconciliation drift, which we solved with an idempotent replay pipeline.',
  'I tracked unmatched transactions, which fell from about two thousand a day to under thirty.',
];

/** The demo session, interviewed part-way and then swept to INCOMPLETE. */
async function incompleteInterview(): Promise<string> {
  await request(app).post(`/api/portal/${demo.token}/accept`).send({});
  await request(app).post(`/api/portal/${demo.token}/consent`).send({ recordingConsent: true, accepted: true });
  await request(app).post(`/api/portal/${demo.token}/start`).send({});
  for (const text of ANSWERS) {
    await request(app).post(`/api/portal/${demo.token}/turn`).send({ text });
  }
  const past = new Date(Date.now() - INACTIVITY_MS - 60_000);
  await prisma.turn.updateMany({ where: { sessionId: demo.sessionId }, data: { createdAt: past } });
  await sweepIncompleteInterviews();
  const swept = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
  expect(swept.state).toBe('INCOMPLETE');
  return demo.sessionId;
}

const REASON = 'Reviewer read the transcript; three full answers are enough to assess fairly.';

describe('assessing an interview that stopped part-way', () => {
  it('produces an assessment instead of failing on the state transition', async () => {
    const sessionId = await incompleteInterview();

    const res = await request(app).post(`/api/interviews/${sessionId}/assess-partial`).set(auth()).send({ reason: REASON });

    expect([res.status, typeof res.body.assessmentId]).toEqual([200, 'string']);
  });

  it('creates exactly one assessment when the button is pressed twice at once', async () => {
    const sessionId = await incompleteInterview();

    await Promise.all([
      request(app).post(`/api/interviews/${sessionId}/assess-partial`).set(auth()).send({ reason: REASON }),
      request(app).post(`/api/interviews/${sessionId}/assess-partial`).set(auth()).send({ reason: REASON }),
    ]);

    expect(await prisma.assessmentVersion.count({ where: { sessionId } })).toBe(1);
  });

  it('records the decision to assess only once when two requests race', async () => {
    const sessionId = await incompleteInterview();

    await Promise.all([
      request(app).post(`/api/interviews/${sessionId}/assess-partial`).set(auth()).send({ reason: REASON }),
      request(app).post(`/api/interviews/${sessionId}/assess-partial`).set(auth()).send({ reason: REASON }),
    ]);

    expect(await prisma.auditEvent.count({ where: { action: 'interview.assess_partial', entityId: sessionId } })).toBe(1);
  });

  it('never queues the candidate feedback email for a partial interview', async () => {
    const sessionId = await incompleteInterview();

    await request(app).post(`/api/interviews/${sessionId}/assess-partial`).set(auth()).send({ reason: REASON });

    expect(await prisma.candidateFeedbackEmail.findUnique({ where: { sessionId }, select: { status: true, skipReason: true } }))
      .toEqual({ status: 'SKIPPED', skipReason: 'PARTIAL_INTERVIEW' });
  });

  it('does not record an assess decision for a request that was refused', async () => {
    const session = await sessionIn('INVITED');

    await request(app).post(`/api/interviews/${session.id}/assess-partial`).set(auth()).send({ reason: REASON });

    expect(await prisma.auditEvent.count({ where: { action: 'interview.assess_partial', entityId: session.id } })).toBe(0);
  });
});

describe('an illegal state transition', () => {
  it('is a 409 conflict, not an unexplained server error', () => {
    let thrown: unknown;
    try { assertTransition('CANCELLED', 'CANCELLED'); } catch (err) { thrown = err; }

    expect(thrown instanceof HttpError ? thrown.status : null).toBe(409);
  });

  for (const state of ['MANUAL_HANDOFF', 'ASSESSING', 'CANCELLED', 'INCOMPLETE']) {
    it(`answers 409 when cancelling an interview in ${state}`, async () => {
      const session = await sessionIn(state);

      const res = await request(app).post(`/api/interviews/${session.id}/cancel`).set(auth()).send({});

      expect(res.status).toBe(409);
    });
  }
});

describe('resending an invitation', () => {
  async function invitedSession(state: string) {
    const session = await sessionIn(state);
    await prisma.invitation.create({
      // A real sealed link, so the refusal cannot come from an unreadable token.
      data: { sessionId: session.id, ...invitationSecretColumns(mintInvitationToken()), status: 'sent', eventsJson: '[]', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    return session;
  }

  for (const state of ['ASSESSING', 'INCOMPLETE', 'CANCELLED', 'REVIEW_READY', 'MANUAL_HANDOFF']) {
    it(`refuses a session in ${state}, whose link would not start an interview`, async () => {
      const session = await invitedSession(state);

      const res = await request(app).post(`/api/interviews/${session.id}/resend`).set(auth()).send({});

      expect(res.status).toBe(409);
    });
  }

  // The interview page says "Interview completed on <date>" instead of offering
  // a resend the server would refuse; it needs the dates to say it.
  it('reports when the interview started and completed', async () => {
    const session = await invitedSession('REVIEW_READY');
    const startedAt = new Date('2026-09-19T08:00:00.000Z');
    const completedAt = new Date('2026-09-19T08:40:00.000Z');
    await prisma.interviewSession.update({ where: { id: session.id }, data: { startedAt, completedAt } });

    const res = await request(app).get(`/api/interviews/${session.id}`).set(auth());

    expect({ startedAt: res.body.session.startedAt, completedAt: res.body.session.completedAt })
      .toEqual({ startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString() });
  });
});

describe('scheduling an interview', () => {
  const at = { scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };

  for (const state of ['CLOSED', 'CANCELLED', 'REVIEW_READY', 'ASSESSING', 'CANDIDATE_WITHDREW']) {
    it(`refuses a session that is already ${state}`, async () => {
      const session = await sessionIn(state);

      const res = await request(app).post(`/api/interviews/${session.id}/schedule`).set(auth()).send(at);

      expect(res.status).toBe(409);
    });
  }

  it('still schedules one that has not happened yet', async () => {
    const session = await sessionIn('INVITED');

    const res = await request(app).post(`/api/interviews/${session.id}/schedule`).set(auth()).send(at);

    expect(res.status).toBe(200);
  });
});
