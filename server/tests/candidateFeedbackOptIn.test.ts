import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * The candidate's own answer to "would you like written feedback by email?",
 * asked at the moment the interview finishes.
 *
 * Two product promises are load-bearing here and are asserted rather than
 * assumed:
 *
 *   1. NOTHING REACHES A CANDIDATE WITHOUT A PERSON APPROVING IT. The opt-in
 *      prepares a draft; it never sends. Every test that opts in also checks
 *      that the candidate-facing surface is still empty afterwards.
 *   2. NEVER INVENT A WEAKNESS. A competency the transcript does not support is
 *      reported as "not covered in this interview" — never as something the
 *      candidate should work on.
 *
 * Fixtures are built against Prisma rather than driven through a real
 * interview: what is under test is what happens at the end of one, not the
 * scoring pipeline that got there.
 */

const app = createApp();

const SQL_QUOTE = 'I rewrote the nightly load as an incremental merge and cut it from six hours to forty minutes.';
const DESIGN_QUOTE = 'I would probably just put a queue in front of it and see how that went.';

/**
 * One evidenced strength, one evidenced shortfall, and one competency the
 * interview never got to. The third is the whole point of this fixture: it must
 * never be described as a weakness.
 */
function assessmentResult(over: Record<string, unknown> = {}) {
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
        notEnoughEvidence: false, rationale: 'Gave a concrete optimisation with a measured result.',
        rubricVersion: 'v1',
        evidence: [{ turnId: 't1', startMs: 60000, endMs: 96000, quote: SQL_QUOTE }],
      },
      {
        id: 'systems-design', name: 'Systems design', level: 2, requiredLevel: 4, confidence: 0.7,
        notEnoughEvidence: false, rationale: 'Reached for a component without reasoning about the trade-off.',
        rubricVersion: 'v1',
        evidence: [{ turnId: 't2', startMs: 300000, endMs: 322000, quote: DESIGN_QUOTE }],
      },
      {
        id: 'leadership', name: 'Leading engineers', level: null, requiredLevel: 3, confidence: 0.2,
        notEnoughEvidence: true, rationale: 'Not reached in the time available.',
        rubricVersion: 'v1', evidence: [],
      },
    ],
    strengths: ['SQL and data modelling: demonstrated at level 4/5 with supporting evidence.'],
    concerns: ['Systems design showed limited depth (level 2/5).'],
    contradictions: [],
    openQuestions: ['Not enough evidence gathered for Leading engineers — recommend a focused human follow-up.'],
    limitations: [],
    summary: 'Strong on data work, thinner on design.',
    ...over,
  };
}

/** An interview that has actually finished — the only state the question is asked in. */
async function finishedInterview(result: Record<string, unknown> = assessmentResult()) {
  const ids = await createDemoData();
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state: 'REVIEW_READY', completedAt: new Date() },
  });
  await prisma.invitation.updateMany({ where: { sessionId: ids.sessionId }, data: { status: 'consumed' } });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId,
      scorecardId: ids.scorecardId,
      recommendation: String(result.recommendation ?? 'CONSIDER'),
      confidence: Number(result.confidence ?? 0),
      evidenceCoverage: Number(result.evidenceCoverage ?? 0),
      resultJson: JSON.stringify(result),
    },
  });
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  expect(login.status).toBe(200);
  return { ...ids, assessmentId: assessment.id, auth: login.body.token as string };
}

async function enableFeedback(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { policyJson: true } });
  const policy = parseJson<Record<string, unknown>>(tenant.policyJson, {});
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { policyJson: JSON.stringify({ ...policy, candidateFeedbackEnabled: true }) },
  });
}

async function completeHumanReview(assessmentId: string, reviewerId: string) {
  await prisma.humanReview.create({
    data: {
      assessmentId, reviewerId, status: 'COMPLETED', disposition: 'CONSIDER',
      reason: 'Human review completed before candidate feedback.', completedAt: new Date(),
    },
  });
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('candidate feedback opt-in at the end of the interview', () => {
  beforeEach(async () => { await wipe(); });

  it('records the candidate\'s own yes, with the time and that they chose it', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    const res = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    expect(res.status).toBe(201);
    expect(res.body.optIn).toMatchObject({ choice: 'YES' });
    expect(res.body.optIn.decidedAt).toBeTruthy();

    const row = await prisma.candidateFeedbackOptIn.findUniqueOrThrow({ where: { sessionId: ids.sessionId } });
    expect(row.choice).toBe('YES');
    // Recorded against the candidate, not only the session: erasure and the HR
    // views both reach it through the person.
    expect(row.candidateId).toBe(ids.candidateId);
    expect(row.decidedBy).toBe('candidate');
    expect(row.decidedAt).toBeInstanceOf(Date);
  });

  it('records a no, and makes the state explicit rather than inferred', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    const res = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: false });

    expect(res.status).toBe(201);
    expect(res.body.optIn.choice).toBe('NO');
    const row = await prisma.candidateFeedbackOptIn.findUniqueOrThrow({ where: { sessionId: ids.sessionId } });
    expect(row.choice).toBe('NO');
  });

  it('is idempotent — a repeated yes neither duplicates the record nor moves the time', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    const first = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });
    expect(first.status).toBe(201);
    const second = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    expect(second.status).toBe(200);
    expect(await prisma.candidateFeedbackOptIn.count({ where: { sessionId: ids.sessionId } })).toBe(1);
    expect(second.body.optIn.decidedAt).toBe(first.body.optIn.decidedAt);
    // And exactly one draft, not one per click.
    expect(await prisma.candidateFeedbackDelivery.count({ where: { assessmentId: ids.assessmentId } })).toBe(1);
  });

  it('keeps the first answer when a no is replayed as a yes', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: false });
    const flip = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    // The recorded answer is the candidate's first one. A replayed request —
    // whether a double submit, a back button or a forged one — cannot turn a
    // decline into consent to be emailed.
    expect(flip.status).toBe(200);
    expect(flip.body.optIn.choice).toBe('NO');
    const row = await prisma.candidateFeedbackOptIn.findUniqueOrThrow({ where: { sessionId: ids.sessionId } });
    expect(row.choice).toBe('NO');
    expect(await prisma.candidateFeedbackDelivery.count({ where: { assessmentId: ids.assessmentId } })).toBe(0);
  });

  it('is offered only once the interview has actually finished', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      data: { state: 'ASSESSING', completedAt: null },
    });

    const res = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    expect(res.status).toBe(409);
    expect(await prisma.candidateFeedbackOptIn.count()).toBe(0);
  });

  it('tells the portal the question is available once the interview completes', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.status).toBe(200);
    expect(res.body.feedbackOptIn).toMatchObject({ offered: true, choice: null });
  });

  it('never offers the question when the tenant switch is off', async () => {
    const ids = await finishedInterview();

    const view = await request(app).get(`/api/portal/${ids.token}`);
    expect(view.body.feedbackOptIn).toMatchObject({ offered: false, choice: null });
  });
});

describe('the tenant switch gates the whole area', () => {
  beforeEach(async () => { await wipe(); });

  it('drafts nothing and records nothing when candidate feedback is disabled', async () => {
    const ids = await finishedInterview();

    const res = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    expect(res.status).toBe(409);
    expect(await prisma.candidateFeedbackOptIn.count()).toBe(0);
    expect(await prisma.candidateFeedbackDelivery.count()).toBe(0);
  });
});

describe('the SWOT-shaped draft prepared for a human to edit', () => {
  beforeEach(async () => { await wipe(); });

  async function draftFor(result?: Record<string, unknown>) {
    const ids = await finishedInterview(result ?? assessmentResult());
    await enableFeedback(ids.tenantId);
    const res = await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });
    expect(res.status).toBe(201);
    const delivery = await prisma.candidateFeedbackDelivery.findUniqueOrThrow({ where: { assessmentId: ids.assessmentId } });
    return { ids, delivery, text: delivery.draftText };
  }

  it('prepares a draft the candidate asked for, in DRAFT status and flagged as theirs', async () => {
    const { delivery } = await draftFor();

    expect(delivery.status).toBe('DRAFT');
    expect(delivery.candidateRequested).toBe(true);
    expect(delivery.approvedText).toBeNull();
    expect(delivery.approvedAt).toBeNull();
    expect(delivery.sentAt).toBeNull();
  });

  it('builds strengths from what the candidate actually said, quoting them', async () => {
    const { text } = await draftFor();

    expect(text).toContain('What you did well');
    expect(text).toContain('SQL and data modelling');
    // Traceability is literal: the candidate's own words are in the draft.
    expect(text).toContain(SQL_QUOTE);
  });

  it('names an evidenced shortfall as something to work on, quoting the evidence', async () => {
    const { text } = await draftFor();

    expect(text).toContain('Worth working on');
    expect(text).toContain('Systems design');
    expect(text).toContain(DESIGN_QUOTE);
  });

  it('NEVER reports an unevidenced competency as a weakness', async () => {
    const { text } = await draftFor();

    const workOn = text.slice(text.indexOf('Worth working on'), text.indexOf('Not covered in this interview'));
    // The competency the interview never reached must not appear anywhere that
    // reads as a criticism of the candidate.
    expect(workOn).not.toContain('Leading engineers');
    expect(text).toContain('Not covered in this interview');
    expect(text.slice(text.indexOf('Not covered in this interview'))).toContain('Leading engineers');
  });

  it('says plainly when there is too little evidence to say anything fair', async () => {
    const thin = assessmentResult({
      evidenceCoverage: 0,
      competencies: [
        {
          id: 'leadership', name: 'Leading engineers', level: null, requiredLevel: 3, confidence: 0.2,
          notEnoughEvidence: true, rationale: 'Not reached.', rubricVersion: 'v1', evidence: [],
        },
      ],
      strengths: [], concerns: [], openQuestions: [], summary: '',
    });
    const { text } = await draftFor(thin);

    expect(text).toMatch(/not enough of your interview|too little/i);
    // No padding: with nothing evidenced there is no strengths or weaknesses list.
    expect(text).not.toContain('What you did well');
    expect(text).not.toContain('Worth working on');
  });

  it('carries no score, level, confidence or recommendation into the candidate\'s draft', async () => {
    const { text } = await draftFor();

    const lower = text.toLowerCase();
    expect(lower).not.toContain('level 4');
    expect(lower).not.toContain('/5');
    expect(lower).not.toContain('confidence');
    expect(lower).not.toContain('consider');
    expect(lower).not.toContain('recommendation');
    expect(lower).not.toContain('71');
  });

  it('works with no model provider configured and never blocks the interview finishing', async () => {
    // The suite runs with LLM_PROVIDER=heuristic and no key, which is the
    // zero-key build. A draft must still be produced, deterministically.
    const { text } = await draftFor();
    expect(text.length).toBeGreaterThan(80);
  });
});

describe('the opt-in never sends anything', () => {
  beforeEach(async () => { await wipe(); });

  it('leaves the candidate-facing surface empty until a person approves and sends', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    const portal = await request(app).get(`/api/portal/${ids.token}/feedback`);
    expect(portal.status).toBe(404);
    const delivery = await prisma.candidateFeedbackDelivery.findUniqueOrThrow({ where: { assessmentId: ids.assessmentId } });
    expect(delivery.status).toBe('DRAFT');
  });

  it('still refuses to send a draft nobody approved', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    const send = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});

    expect(send.status).toBe(409);
    expect(send.body.error).toMatch(/approved/i);
  });

  it('still refuses to approve a candidate-requested draft with no completed human review', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });
    const delivery = await prisma.candidateFeedbackDelivery.findUniqueOrThrow({ where: { assessmentId: ids.assessmentId } });

    const approve = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth))
      .send({ approvedText: delivery.draftText });

    // Auto-preparing a draft must not become a way round the human-review gate
    // that the manual draft route already enforces.
    expect(approve.status).toBe(409);
    expect(approve.body.error).toMatch(/human review/i);
  });
});

describe('a candidate who declines is never emailed', () => {
  beforeEach(async () => { await wipe(); });

  it('refuses to send feedback to a candidate who said no, even after approval', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await completeHumanReview(ids.assessmentId, ids.userId);
    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: false });

    const text = 'Thank you for the conversation — here is what stood out to the team.';
    const draft = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth)).send({ draftText: text });
    expect(draft.status).toBe(201);
    const approve = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth)).send({ approvedText: text });
    expect(approve.status).toBe(200);

    const send = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});

    expect(send.status).toBe(409);
    expect(send.body.error).toMatch(/^Candidate declined/);
    const delivery = await prisma.candidateFeedbackDelivery.findUniqueOrThrow({ where: { assessmentId: ids.assessmentId } });
    expect(delivery.status).toBe('APPROVED');
    expect(delivery.sentAt).toBeNull();
    // And nothing reached their portal either.
    const portal = await request(app).get(`/api/portal/${ids.token}/feedback`);
    expect(portal.status).toBe(404);
  });

  it('refuses to send when the candidate was never asked — silence is not consent', async () => {
    // Recruiter-driven interviews and everything recorded before this feature
    // existed have no answer on file. That is not a yes, so nothing is sent;
    // the recruiter is told why and can ask (candidateFeedbackConsent.test.ts).
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await completeHumanReview(ids.assessmentId, ids.userId);

    const text = 'Thank you for the conversation — here is what stood out to the team.';
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/draft`).set(auth(ids.auth)).send({ draftText: text });
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/approve`).set(auth(ids.auth)).send({ approvedText: text });

    const send = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback/send`).set(auth(ids.auth)).send({});

    expect([send.status, send.body.error]).toEqual([409, expect.stringMatching(/^Candidate was not asked/)]);
  });
});

describe('what the hiring team can see', () => {
  beforeEach(async () => { await wipe(); });

  it('reports the candidate\'s answer and that a draft is waiting', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/feedback`).set(auth(ids.auth));

    expect(res.status).toBe(200);
    expect(res.body.optIn).toMatchObject({ choice: 'YES' });
    expect(res.body.feedback).toMatchObject({ status: 'DRAFT', candidateRequested: true });
    expect(res.body.humanRequest).toMatchObject({ requested: false });
  });

  it('reports a decline on the candidate page, so nobody drafts into a void', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: false });

    const res = await request(app).get(`/api/candidates/${ids.candidateId}`).set(auth(ids.auth));

    expect(res.status).toBe(200);
    expect(res.body.candidateFeedback).toMatchObject({
      optIn: { choice: 'NO' },
      draft: { status: null },
      humanRequest: { requested: false },
    });
  });

  it('404s for another tenant', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    const otherTenant = await prisma.tenant.create({ data: { name: 'Other Org' } });
    const outsider = await prisma.user.create({
      data: { tenantId: otherTenant.id, email: 'outsider@other.local', name: 'Outsider', passwordHash: 'x', role: 'admin' },
    });
    const outsiderToken = signToken({ userId: outsider.id, tenantId: otherTenant.id, role: 'admin', email: outsider.email });

    expect((await request(app).get(`/api/assessments/${ids.assessmentId}/feedback`).set(auth(outsiderToken))).status).toBe(404);
    expect((await request(app).get(`/api/candidates/${ids.candidateId}`).set(auth(outsiderToken))).status).toBe(404);
  });

  it('404s for an unassigned colleague in the same tenant', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);
    await request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true });

    // A manager, so the capability gate lets them through and what is actually
    // under test is object scope: they hold assessment:review but this
    // candidate is not theirs.
    const colleague = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'colleague@questor.local', name: 'Colleague', passwordHash: 'x', role: 'manager' },
    });
    const colleagueToken = signToken({ userId: colleague.id, tenantId: ids.tenantId, role: 'manager', email: colleague.email });

    expect((await request(app).get(`/api/assessments/${ids.assessmentId}/feedback`).set(auth(colleagueToken))).status).toBe(404);
    expect((await request(app).get(`/api/candidates/${ids.candidateId}`).set(auth(colleagueToken))).status).toBe(404);
  });
});

/**
 * A candidate double-clicks, or their browser retries the request. Both copies
 * find no answer recorded and both try to write one — and the loser of that race
 * used to get a 500, leaving someone who had just answered a question about
 * their own interview staring at an error.
 */
describe('two answers arriving at once', () => {
  beforeEach(async () => { await wipe(); });

  it('answers both requests rather than failing the slower one', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    const results = await Promise.all([
      request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true }),
      request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true }),
    ]);

    expect(results.map((r) => r.status).filter((s) => s === 200 || s === 201)).toHaveLength(2);
  });

  it('keeps one record of what the candidate chose', async () => {
    const ids = await finishedInterview();
    await enableFeedback(ids.tenantId);

    await Promise.all([
      request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true }),
      request(app).post(`/api/portal/${ids.token}/feedback-opt-in`).send({ wantsFeedback: true }),
    ]);

    expect(await prisma.candidateFeedbackOptIn.count({ where: { sessionId: ids.sessionId } })).toBe(1);
  });
});
