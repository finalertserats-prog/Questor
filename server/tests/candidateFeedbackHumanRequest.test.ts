import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { eraseCandidate, runRetentionSweep } from '../src/services/dataRights.js';

/**
 * The feedback email a candidate receives, and the one thing it asks them:
 * would you like to speak to a person?
 *
 * The link in that email is a bearer credential sitting in someone's mailbox.
 * It is therefore built to be worth as little as possible if it leaks: it does
 * one thing, it expires, it is stored only as a hash, and it can read nothing.
 * Each of those is asserted below, because each is the kind of property that
 * quietly stops being true.
 */

// The console provider delivers nothing, so the send path would never build an
// email to inspect. This stands in for a provider that does deliver, and keeps
// every message for assertion.
const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string; html: string }>);

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test',
      configured: true,
      delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        sent.push(msg);
        return { status: 'sent', id: `test-${sent.length}` };
      },
    }),
  };
});

const app = createApp();

const SQL_QUOTE = 'I rewrote the nightly load as an incremental merge and cut it from six hours to forty minutes.';

function assessmentResult() {
  return {
    assessmentVersion: 'A-test-v1',
    roleScorecardVersion: 'sc-1',
    recommendation: 'CONSIDER',
    confidence: 0.78,
    evidenceCoverage: 0.67,
    overallScore: 71,
    competencies: [
      {
        id: 'sql', name: 'SQL and data modelling', level: 4, requiredLevel: 3, confidence: 0.81,
        notEnoughEvidence: false, rationale: 'Concrete optimisation with a measured result.',
        rubricVersion: 'v1',
        evidence: [{ turnId: 't1', startMs: 60000, endMs: 96000, quote: SQL_QUOTE }],
      },
      {
        id: 'leadership', name: 'Leading engineers', level: null, requiredLevel: 3, confidence: 0.2,
        notEnoughEvidence: true, rationale: 'Not reached.', rubricVersion: 'v1', evidence: [],
      },
    ],
    strengths: ['SQL and data modelling: demonstrated at level 4/5 with supporting evidence.'],
    concerns: [],
    contradictions: [],
    openQuestions: [],
    limitations: [],
    summary: 'Strong on data work.',
  };
}

async function enableFeedback(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { policyJson: true } });
  const policy = parseJson<Record<string, unknown>>(tenant.policyJson, {});
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { policyJson: JSON.stringify({ ...policy, candidateFeedbackEnabled: true }) },
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Opt in, review, approve and send — the whole human-approved path, end to end. */
async function sentFeedback() {
  const ids = await createDemoData();
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state: 'REVIEW_READY', completedAt: new Date() },
  });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER',
      confidence: 0.78, evidenceCoverage: 0.67, resultJson: JSON.stringify(assessmentResult()),
    },
  });
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  const token = login.body.token as string;
  await enableFeedback(ids.tenantId);

  const optIn = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });
  expect(optIn.status).toBe(201);

  await prisma.humanReview.create({
    data: {
      assessmentId: assessment.id, reviewerId: ids.userId, status: 'COMPLETED', disposition: 'CONSIDER',
      reason: 'Reviewed.', completedAt: new Date(),
    },
  });
  const delivery = await prisma.candidateFeedbackDelivery.findUniqueOrThrow({ where: { assessmentId: assessment.id } });
  const approve = await request(app).post(`/api/assessments/${assessment.id}/feedback/approve`).set(auth(token))
    .send({ approvedText: delivery.draftText });
  expect(approve.status).toBe(200);

  const send = await request(app).post(`/api/assessments/${assessment.id}/feedback/send`).set(auth(token)).send({});
  expect(send.status).toBe(200);

  const email = sent[sent.length - 1];
  const match = /\/talk-to-a-person\/([A-Za-z0-9_-]+)/.exec(email.text);
  return { ...ids, assessmentId: assessment.id, auth: token, email, humanToken: match?.[1] ?? '' };
}

describe('the feedback email', () => {
  beforeEach(async () => { await wipe(); sent.length = 0; });

  it('goes to the candidate, branded, in both plain text and HTML', async () => {
    const { email, candidateId } = await sentFeedback();
    const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });

    expect(email.to).toBe(candidate.email);
    expect(email.subject).toMatch(/feedback/i);
    // brandedEmail() decorates only the HTML — the plain-text body is the one a
    // stripped-down mail client shows, so it has to stand on its own.
    expect(email.html).toContain('questor-wordmark.png');
    expect(email.text).toContain('What you did well');
    expect(email.html).toContain('What you did well');
    expect(email.text).toContain(SQL_QUOTE);
    expect(email.html).toContain('Leading engineers');
  });

  it('carries no scores, levels or recommendation to the candidate', async () => {
    const { email } = await sentFeedback();

    const both = `${email.text} ${email.html}`.toLowerCase();
    expect(both).not.toContain('/5');
    expect(both).not.toContain('confidence');
    expect(both).not.toContain('recommendation');
  });

  it('escapes anything a reviewer typed rather than rendering it as markup', async () => {
    const ids = await createDemoData();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
    const assessment = await prisma.assessmentVersion.create({
      data: { sessionId: ids.sessionId, scorecardId: ids.scorecardId, resultJson: JSON.stringify(assessmentResult()) },
    });
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
    const token = login.body.token as string;
    await enableFeedback(ids.tenantId);
    await prisma.humanReview.create({
      data: { assessmentId: assessment.id, reviewerId: ids.userId, status: 'COMPLETED', disposition: 'CONSIDER', reason: 'r', completedAt: new Date() },
    });

    const nasty = 'Thanks for your time. <img src=x onerror=alert(1)> We enjoyed it.';
    await request(app).post(`/api/assessments/${assessment.id}/feedback/draft`).set(auth(token)).send({ draftText: nasty });
    await request(app).post(`/api/assessments/${assessment.id}/feedback/approve`).set(auth(token)).send({ approvedText: nasty });
    await request(app).post(`/api/assessments/${assessment.id}/feedback/send`).set(auth(token)).send({});

    const email = sent[sent.length - 1];
    expect(email.html).not.toContain('<img src=x');
    // Numeric character references, matching the convention branding.ts already
    // uses. Inert either way — what matters is that the angle brackets a
    // reviewer typed never reach the candidate's mail client as markup.
    expect(email.html).toContain('&#60;img');
  });

  it('asks whether they would like to speak to a person, with a link', async () => {
    const { email, humanToken } = await sentFeedback();

    expect(email.text).toMatch(/speak to (a|someone)/i);
    expect(humanToken.length).toBeGreaterThanOrEqual(24);
    expect(email.html).toContain(`/talk-to-a-person/${humanToken}`);
  });
});

describe('the talk-to-a-person link', () => {
  beforeEach(async () => { await wipe(); sent.length = 0; });

  it('is not the interview token, and the interview token does not work in its place', async () => {
    const { humanToken, token } = await sentFeedback();

    expect(humanToken).not.toBe(token);
    expect((await request(app).get(`/api/feedback-request/${token}`)).status).toBe(404);
    // ...and it is useless on the portal it did not come from.
    expect((await request(app).get(`/api/portal/${humanToken}`)).status).toBe(404);
  });

  it('is stored only as a hash, so the database does not hold a working link', async () => {
    const { humanToken, sessionId } = await sentFeedback();

    const row = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId } });
    expect(row.tokenHash).not.toContain(humanToken);
    expect(JSON.stringify(row)).not.toContain(humanToken);
  });

  it('records the request when the candidate confirms, and is safe to click twice', async () => {
    const { humanToken, sessionId, candidateId } = await sentFeedback();

    const first = await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ recorded: true });

    const row = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId } });
    expect(row.status).toBe('REQUESTED');
    expect(row.requestedAt).toBeInstanceOf(Date);
    expect(row.candidateId).toBe(candidateId);

    const second = await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ recorded: true });

    const after = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId } });
    // Replaying it must not rewrite when they asked.
    expect(after.requestedAt?.toISOString()).toBe(row.requestedAt?.toISOString());
    expect(await prisma.candidateHumanRequest.count()).toBe(1);
  });

  it('expires', async () => {
    const { humanToken, sessionId } = await sentFeedback();
    await prisma.candidateHumanRequest.update({
      where: { sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await request(app).get(`/api/feedback-request/${humanToken}`)).status).toBe(410);
    const confirm = await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});
    expect(confirm.status).toBe(410);
    const row = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId } });
    expect(row.status).toBe('ISSUED');
    expect(row.requestedAt).toBeNull();
  });

  it('refuses a token nobody issued', async () => {
    await sentFeedback();

    expect((await request(app).get('/api/feedback-request/not-a-real-token-at-all')).status).toBe(404);
    expect((await request(app).post('/api/feedback-request/not-a-real-token-at-all/confirm').send({})).status).toBe(404);
  });

  it('cannot be used to read anything about the candidate or anyone else', async () => {
    const { humanToken, candidateId } = await sentFeedback();
    const candidate = await prisma.candidate.findUniqueOrThrow({ where: { id: candidateId } });

    const res = await request(app).get(`/api/feedback-request/${humanToken}`);

    expect(res.status).toBe(200);
    // Exactly one fact: is this link still good? Nothing else.
    expect(Object.keys(res.body).sort()).toEqual(['state']);
    expect(res.body.state).toBe('open');
    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).not.toContain(candidate.fullName.toLowerCase());
    expect(body).not.toContain(candidate.email.toLowerCase());
    expect(body).not.toContain('sharma');
    expect(body).not.toContain(candidateId);

    await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});
    const after = await request(app).get(`/api/feedback-request/${humanToken}`);
    expect(after.body).toEqual({ state: 'recorded' });
  });

  it('requires no login', async () => {
    const { humanToken } = await sentFeedback();

    // No Authorization header, no cookie — a candidate has neither.
    const res = await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});

    expect(res.status).toBe(200);
  });

  it('shows the request to the hiring team', async () => {
    const { humanToken, assessmentId, candidateId, auth: hrToken } = await sentFeedback();
    await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});

    const onAssessment = await request(app).get(`/api/assessments/${assessmentId}/feedback`).set(auth(hrToken));
    expect(onAssessment.body.humanRequest).toMatchObject({ requested: true });
    expect(onAssessment.body.humanRequest.requestedAt).toBeTruthy();

    const onCandidate = await request(app).get(`/api/candidates/${candidateId}`).set(auth(hrToken));
    expect(onCandidate.body.candidateFeedback.humanRequest).toMatchObject({ requested: true });
  });

  it('leaves the completed interview\'s own state alone', async () => {
    const { humanToken, sessionId } = await sentFeedback();
    await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    // MANUAL_HANDOFF means "the AI interview stopped and a person must take over
    // mid-interview" — it is counted with no-shows and technical failures. A
    // finished interview whose candidate would like a chat is a different fact,
    // and reusing that state would misreport the interview as failed.
    expect(session.state).toBe('REVIEW_READY');
    expect(session.completedAt).not.toBeNull();
  });
});

describe('erasure and retention reach everything this feature stores', () => {
  beforeEach(async () => { await wipe(); sent.length = 0; });

  it('erasing a candidate removes the opt-in, the delivered feedback and the human request', async () => {
    const { humanToken, candidateId, tenantId, userId } = await sentFeedback();
    await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});

    expect(await prisma.candidateFeedbackOptIn.count()).toBe(1);
    expect(await prisma.candidateHumanRequest.count()).toBe(1);
    expect(await prisma.candidateFeedbackDelivery.count()).toBe(1);

    await eraseCandidate({ tenantId, candidateId, actorId: userId, reason: 'Candidate asked us to delete their data.' });

    expect(await prisma.candidateFeedbackOptIn.count()).toBe(0);
    expect(await prisma.candidateHumanRequest.count()).toBe(0);
    // The draft quotes the candidate verbatim — it is transcript data by
    // another name and must not survive an erasure that reports success.
    expect(await prisma.candidateFeedbackDelivery.count()).toBe(0);
    expect(await prisma.candidate.count({ where: { id: candidateId } })).toBe(0);
  });

  it('the retention sweep removes them once the window closes', async () => {
    const { humanToken, sessionId, candidateId } = await sentFeedback();
    await request(app).post(`/api/feedback-request/${humanToken}/confirm`).send({});
    await prisma.interviewSession.update({
      where: { id: sessionId },
      data: { retainUntil: new Date(Date.now() - 86_400_000), completedAt: new Date(Date.now() - 400 * 86_400_000) },
    });

    await runRetentionSweep();

    expect(await prisma.candidateFeedbackOptIn.count()).toBe(0);
    expect(await prisma.candidateHumanRequest.count()).toBe(0);
    expect(await prisma.candidateFeedbackDelivery.count()).toBe(0);
    expect(await prisma.interviewSession.count({ where: { id: sessionId } })).toBe(0);
    expect(await prisma.candidate.count({ where: { id: candidateId } })).toBe(0);
  });
});
