import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { eraseCandidate } from '../src/services/dataRights.js';
import { hashCandidateLinkToken } from '../src/services/candidateLinkToken.js';
import { signToken } from '../src/services/auth.js';

/**
 * Written feedback is sent only to a candidate who said yes.
 *
 * There are three states and they are kept apart all the way to the recruiter:
 * never asked (blocked, and the recruiter can ask), declined (blocked, and
 * nobody asks again), opted in (can be sent once a person has approved it).
 * An interview from before this rule, with no answer on file, is "never asked".
 */

const sent = vi.hoisted(() => ({
  messages: [] as Array<{ to: string; subject: string; text: string; html: string }>,
  delivers: true,
}));

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test',
      configured: true,
      delivers: sent.delivers,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        sent.messages.push(msg);
        return { status: 'sent', id: `test-${sent.messages.length}` };
      },
    }),
  };
});

const app = createApp();
const TEXT = 'Thank you for the conversation. Here is what stood out to the team.';

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function enableFeedback(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { policyJson: true } });
  const policy = parseJson<Record<string, unknown>>(tenant.policyJson, {});
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { policyJson: JSON.stringify({ ...policy, candidateFeedbackEnabled: true }) },
  });
}

/** A finished, reviewed interview with feedback approved and waiting to go. */
async function approvedFeedback() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
  await prisma.invitation.updateMany({ where: { sessionId: ids.sessionId }, data: { status: 'consumed' } });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER',
      confidence: 0.8, evidenceCoverage: 0.6, resultJson: JSON.stringify({ competencies: [], strengths: [], concerns: [] }),
    },
  });
  await prisma.humanReview.create({
    data: {
      assessmentId: assessment.id, reviewerId: ids.userId, status: 'COMPLETED', disposition: 'CONSIDER',
      reason: 'Reviewed.', completedAt: new Date(),
    },
  });
  await enableFeedback(ids.tenantId);
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  const authToken = login.body.token as string;
  await request(app).post(`/api/assessments/${assessment.id}/feedback/draft`).set(auth(authToken)).send({ draftText: TEXT });
  const approve = await request(app).post(`/api/assessments/${assessment.id}/feedback/approve`).set(auth(authToken))
    .send({ approvedText: TEXT });
  expect(approve.status).toBe(200);
  return { ...ids, assessmentId: assessment.id, auth: authToken };
}

type Fixture = Awaited<ReturnType<typeof approvedFeedback>>;

const answerAtEnd = (f: Fixture, wantsFeedback: boolean) =>
  request(app).post(`/api/portal/${f.token}/feedback-opt-in`).send({ wantsFeedback });
const send = (f: Fixture) => request(app).post(`/api/assessments/${f.assessmentId}/feedback/send`).set(auth(f.auth)).send({});
const feedbackView = (f: Fixture) => request(app).get(`/api/assessments/${f.assessmentId}/feedback`).set(auth(f.auth));
const askToOptIn = (f: Fixture) =>
  request(app).post(`/api/assessments/${f.assessmentId}/feedback/opt-in-request`).set(auth(f.auth)).send({});

/** Ask, and pull the link token out of the email that went to the candidate. */
async function requestLink(f: Fixture): Promise<string> {
  const res = await askToOptIn(f);
  expect(res.status).toBe(200);
  const match = /\/feedback-consent\/([A-Za-z0-9_-]+)/.exec(sent.messages[sent.messages.length - 1].text);
  return match?.[1] ?? '';
}

beforeEach(async () => {
  await wipe();
  sent.messages.length = 0;
  sent.delivers = true;
});

describe('a candidate who was never asked', () => {
  it('cannot be sent feedback', async () => {
    const f = await approvedFeedback();

    const res = await send(f);

    expect([res.status, res.body.error]).toEqual([409, expect.stringMatching(/^Candidate was not asked/)]);
  });

  it('keeps the approved feedback unsent and off their portal', async () => {
    const f = await approvedFeedback();

    await send(f);

    const delivery = await prisma.candidateFeedbackDelivery.findUniqueOrThrow({ where: { assessmentId: f.assessmentId } });
    const portal = await request(app).get(`/api/portal/${f.token}/feedback`);
    expect([delivery.status, delivery.sentAt, portal.status]).toEqual(['APPROVED', null, 404]);
  });

  it('is shown to the recruiter as not asked, with the reason and a way to ask', async () => {
    const f = await approvedFeedback();

    const res = await feedbackView(f);

    expect(res.body.consent).toMatchObject({
      status: 'NOT_ASKED', canSend: false, blockReason: expect.stringMatching(/^Candidate was not asked/),
      canRequest: true, request: null,
    });
  });

  it('is what an interview from before this rule looks like — no answer on file', async () => {
    const f = await approvedFeedback();

    expect(await prisma.candidateFeedbackOptIn.count({ where: { sessionId: f.sessionId } })).toBe(0);
    expect((await feedbackView(f)).body.consent.status).toBe('NOT_ASKED');
  });
});

describe('a candidate who declined', () => {
  it('cannot be sent feedback, for a different stated reason', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, false);

    const res = await send(f);

    expect([res.status, res.body.error]).toEqual([409, expect.stringMatching(/^Candidate declined/)]);
  });

  it('is shown to the recruiter as declined, with no way to ask again', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, false);

    const res = await feedbackView(f);

    expect(res.body.consent).toMatchObject({
      status: 'DECLINED', canSend: false, blockReason: expect.stringMatching(/^Candidate declined/), canRequest: false,
    });
  });

  it('is not sent a request to opt in', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, false);

    const res = await askToOptIn(f);

    expect([res.status, sent.messages.length]).toEqual([409, 0]);
  });
});

describe('a candidate who opted in', () => {
  it('can be sent the approved feedback', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, true);

    const res = await send(f);

    expect([res.status, res.body.feedback.status]).toEqual([200, 'SENT']);
  });

  it('is shown to the recruiter as sendable', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, true);

    const res = await feedbackView(f);

    expect(res.body.consent).toMatchObject({ status: 'OPTED_IN', canSend: true, blockReason: null, canRequest: false });
  });

  it('is not asked again', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, true);

    expect((await askToOptIn(f)).status).toBe(409);
  });
});

describe('the audit trail of the answer', () => {
  it('records an opt-in, and where it came from', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, true);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'feedback.opted_in', entityId: f.sessionId } });
    expect(parseJson<Record<string, unknown>>(event.afterJson ?? '{}', {})).toMatchObject({ choice: 'YES', via: 'end-of-interview' });
  });

  it('records an opt-out', async () => {
    const f = await approvedFeedback();
    await answerAtEnd(f, false);

    expect(await prisma.auditEvent.count({ where: { action: 'feedback.opted_out', entityId: f.sessionId } })).toBe(1);
  });
});

describe('asking a candidate to opt in', () => {
  it('emails the candidate a link to answer', async () => {
    const f = await approvedFeedback();

    const token = await requestLink(f);

    const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: f.candidateId } });
    expect([sent.messages[0].to, token.length > 30]).toEqual([candidate.email, true]);
  });

  it('puts the link in the HTML as well', async () => {
    const f = await approvedFeedback();

    const token = await requestLink(f);

    expect(sent.messages[0].html).toContain(`/feedback-consent/${token}`);
  });

  it('stores only the hash of the link', async () => {
    const f = await approvedFeedback();

    const token = await requestLink(f);

    const row = await prisma.candidateFeedbackOptInRequest.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
    expect([row.tokenHash, JSON.stringify(row).includes(token)]).toEqual([hashCandidateLinkToken(token), false]);
  });

  it('is audited with who asked', async () => {
    const f = await approvedFeedback();

    await requestLink(f);

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'feedback.optin.requested', entityId: f.sessionId } });
    expect(event.actorId).toBe(f.userId);
  });

  it('tells the recruiter the request is out, and until when the link works', async () => {
    const f = await approvedFeedback();
    await requestLink(f);

    const res = await feedbackView(f);

    expect(res.body.consent.request).toMatchObject({ issuedAt: expect.any(String), expiresAt: expect.any(String) });
  });

  it('does not send feedback, and records no answer', async () => {
    const f = await approvedFeedback();

    await requestLink(f);

    const delivery = await prisma.candidateFeedbackDelivery.findUniqueOrThrow({ where: { assessmentId: f.assessmentId } });
    expect([delivery.status, await prisma.candidateFeedbackOptIn.count()]).toEqual(['APPROVED', 0]);
  });

  it('refuses when email cannot reach the candidate, rather than creating a link nobody gets', async () => {
    const f = await approvedFeedback();
    sent.delivers = false;

    const res = await askToOptIn(f);

    expect([res.status, await prisma.candidateFeedbackOptIn.count(), await prisma.candidateFeedbackOptInRequest.count()])
      .toEqual([409, 0, 0]);
  });

  it('refuses when the tenant has candidate feedback switched off', async () => {
    const f = await approvedFeedback();
    await prisma.tenant.update({ where: { id: f.tenantId }, data: { policyJson: '{}' } });

    expect((await askToOptIn(f)).status).toBe(409);
  });

  it('is not sent again within the hour, so a candidate is not pestered', async () => {
    const f = await approvedFeedback();
    await requestLink(f);

    const again = await askToOptIn(f);

    expect([again.status, sent.messages.length]).toEqual([429, 1]);
  });

  it('replaces the link when sent again, so only the newest one works', async () => {
    const f = await approvedFeedback();
    const first = await requestLink(f);
    // Past the resend cooldown.
    await prisma.candidateFeedbackOptInRequest.updateMany({ data: { issuedAt: new Date(Date.now() - 2 * 60 * 60_000) } });
    await requestLink(f);

    const res = await request(app).get(`/api/feedback-consent/${first}`);

    expect(res.status).toBe(404);
  });

  it('is scoped to the caller\'s tenant', async () => {
    const f = await approvedFeedback();
    const other = await prisma.tenant.create({ data: { name: 'Elsewhere' } });
    const outsider = await prisma.user.create({
      data: { tenantId: other.id, email: 'out@elsewhere.local', name: 'Out', passwordHash: 'x', role: 'admin' },
    });
    const token = signToken({ userId: outsider.id, tenantId: other.id, role: 'admin', email: outsider.email });

    const res = await request(app).post(`/api/assessments/${f.assessmentId}/feedback/opt-in-request`).set(auth(token)).send({});

    expect([res.status, sent.messages.length]).toEqual([404, 0]);
  });
});

describe('the opt-in link', () => {
  it('says it is open, and nothing else', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);

    const res = await request(app).get(`/api/feedback-consent/${token}`);

    expect([res.status, res.body]).toEqual([200, { state: 'open' }]);
  });

  it('records nothing when merely opened', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);

    await request(app).get(`/api/feedback-consent/${token}`);

    expect(await prisma.candidateFeedbackOptIn.count()).toBe(0);
  });

  it('records a yes as the candidate\'s own, and makes the feedback sendable', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);

    const answer = await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: true });

    const row = await prisma.candidateFeedbackOptIn.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
    expect([answer.status, row.choice, row.decidedBy, (await send(f)).status]).toEqual([201, 'YES', 'candidate', 200]);
  });

  it('audits a yes given through the link as such', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);

    await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: true });

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'feedback.opted_in', entityId: f.sessionId } });
    expect(parseJson<Record<string, unknown>>(event.afterJson ?? '{}', {})).toMatchObject({ via: 'emailed-request' });
  });

  it('records a no, which then blocks sending as a decline', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);

    await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: false });

    expect((await send(f)).body.error).toMatch(/^Candidate declined/);
  });

  it('keeps the first answer when clicked again the other way', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);
    await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: false });

    const replay = await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: true });

    const row = await prisma.candidateFeedbackOptIn.findUniqueOrThrow({ where: { sessionId: f.sessionId } });
    expect([replay.status, replay.body.state, row.choice]).toEqual([200, 'answered', 'NO']);
  });

  it('says it has been answered, without saying what the answer was', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);
    await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: false });

    const res = await request(app).get(`/api/feedback-consent/${token}`);

    expect(res.body).toEqual({ state: 'answered' });
  });

  it('expires', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);
    await prisma.candidateFeedbackOptInRequest.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const answer = await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: true });

    expect([answer.status, await prisma.candidateFeedbackOptIn.count()]).toEqual([410, 0]);
  });

  it('refuses a token nobody issued', async () => {
    const res = await request(app).get(`/api/feedback-consent/${'x'.repeat(43)}`);

    expect(res.status).toBe(404);
  });

  it('is not the interview token, and the interview token does not work in its place', async () => {
    const f = await approvedFeedback();
    await requestLink(f);

    const res = await request(app).get(`/api/feedback-consent/${f.token}`);

    expect(res.status).toBe(404);
  });

  it('is not the talk-to-a-person link either', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);

    expect((await request(app).get(`/api/feedback-request/${token}`)).status).toBe(404);
  });

  it('refuses an answer that is not a yes or a no', async () => {
    const f = await approvedFeedback();
    const token = await requestLink(f);

    const res = await request(app).post(`/api/feedback-consent/${token}/answer`).send({ wantsFeedback: 'yes', extra: 1 });

    expect([res.status, await prisma.candidateFeedbackOptIn.count()]).toEqual([400, 0]);
  });
});

describe('erasure', () => {
  it('removes the opt-in request with the candidate', async () => {
    const f = await approvedFeedback();
    await requestLink(f);

    await eraseCandidate({ tenantId: f.tenantId, candidateId: f.candidateId, actorId: f.userId, reason: 'Candidate asked us to delete their data.' });

    expect(await prisma.candidateFeedbackOptInRequest.count()).toBe(0);
  });
});
