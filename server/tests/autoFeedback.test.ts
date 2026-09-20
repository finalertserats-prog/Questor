import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The candidate's automatic feedback email, end to end: queued when the
 * assessment is stored, sent once by the background job, retried on failure,
 * skipped when it must not go, and sendable by hand from the assessment page.
 * Mail and the model are fakes; nothing leaves the process.
 */

const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; text: string; html: string }>,
  failNext: 0,
  delivers: true,
  /** Set to hold a send open, so a stalled provider can be tested deterministically. */
  hold: null as null | Promise<void>,
  /** Called the moment a held send starts. */
  started: null as null | (() => void),
}));

vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  const provider = {
    name: 'fake',
    configured: true,
    get delivers() { return mail.delivers; },
    async send(msg: { to: string; subject: string; text: string; html: string }) {
      if (mail.failNext > 0) {
        mail.failNext -= 1;
        throw new Error('SMTP 451 try again later');
      }
      if (mail.hold) {
        mail.started?.();
        await mail.hold;
      }
      mail.sent.push(msg);
      return { status: 'sent', id: `fake-${mail.sent.length}` };
    },
  };
  return { ...actual, getEmail: () => provider };
});

const MODEL_CONTENT = {
  swot: {
    strengths: [
      'You walked through the billing pipeline you owned in a way that made each step easy to follow.',
      'You were specific about how you made recovery safe to repeat after a failed load.',
    ],
    weaknesses: [
      'Your examples often stop before the result, so the impact is left unsaid.',
      'Work with the people who depend on the data is described only briefly.',
    ],
    opportunities: [
      'Your habit of tuning queries before anyone complains is worth leading with.',
      'One concrete detail per story would lift every answer you give.',
    ],
    watchOuts: [
      'Long answers drift, and the strongest point often arrives last.',
      'Saying "we" where it was you reads as a smaller part than you had.',
    ],
  },
  notes: [
    { competencyId: 'sql', whatWeHeard: 'A billing query you rewrote yourself, with the effect on run time spelled out.', toGoFurther: 'Name what the slow query was costing the team before you touched it.' },
    { competencyId: 'stake', whatWeHeard: 'A report you sent on, with little about how you kept people involved afterwards.', toGoFurther: 'Describe how you brought a sceptical colleague along with a change.' },
  ],
  nextSteps: [
    'Add the ending to three of your stories: what changed, and how you knew.',
    'Re-tell one story naming your own decisions rather than the team’s.',
    'Keep a short example ready about growing the people around you.',
  ],
};

const llm = vi.hoisted(() => ({
  reply: '' as string,
  calls: 0,
  /** Set to hold the model open, so a review landing mid-send can be tested deterministically. */
  hold: null as null | Promise<void>,
  started: null as null | (() => void),
}));

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, llm: { ...actual.config.llm, provider: 'anthropic', anthropicKey: 'test-key' } } };
});

vi.mock('../src/providers/llm/anthropic.js', () => ({
  AnthropicLlmProvider: class {
    name = 'anthropic';
    get enabled(): boolean { return true; }
    async generate() {
      llm.calls += 1;
      if (llm.hold) {
        llm.started?.();
        await llm.hold;
      }
      return { text: llm.reply, model: 'fake-model', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
    }
  },
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { createDemoData, wipe } = await import('../src/seed/demoData.js');
const { signToken } = await import('../src/services/auth.js');
const { _resetLlm } = await import('../src/providers/llm/index.js');
const {
  attemptFeedbackEmail, deliverDueFeedbackEmails, enqueueAutoFeedback, FEEDBACK_SEND_STALE_MS,
  rescheduleLegacyFeedbackEmails, _setFeedbackSendTimeoutForTest,
} = await import('../src/services/autoFeedback.js');
const { MAX_SEND_ATTEMPTS } = await import('../src/services/autoFeedbackModel.js');
const { TALK_LINK_PLACEHOLDER } = await import('../src/providers/email/autoFeedbackEmail.js');

const app = createApp();

const RESULT = {
  assessmentVersion: 'A-1', roleScorecardVersion: 's', recommendation: 'DO_NOT_PROGRESS', confidence: 0.7,
  evidenceCoverage: 0.6, overallScore: 41,
  competencies: [
    { id: 'sql', name: 'SQL', level: 4, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false, rationale: '', rubricVersion: 'r',
      evidence: [{ turnId: 't1', startMs: 0, endMs: 1, quote: 'I rewrote the billing query with a window function and it ran in seconds.' }] },
    { id: 'stake', name: 'Stakeholder management', level: 2, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false, rationale: '', rubricVersion: 'r',
      evidence: [{ turnId: 't2', startMs: 0, endMs: 1, quote: 'I sent the report and moved on.' }] },
  ],
  strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'Scored 41/100.',
};

/**
 * A finished interview with an assessment stored. The review window is zero
 * unless a test is about the waiting itself, so tests about sending, skipping
 * and retrying are not also tests of the clock.
 */
async function completedInterview(opts: { state?: string; isDemo?: boolean; email?: string; windowHours?: number } = {}) {
  const ids = await createDemoData();
  await setPolicy(ids.tenantId, { feedbackReviewWindowHours: opts.windowHours ?? 0 });
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state: opts.state ?? 'REVIEW_READY', completedAt: new Date() },
  });
  if (opts.isDemo) await prisma.tenant.update({ where: { id: ids.tenantId }, data: { isDemo: true } });
  if (opts.email !== undefined) await prisma.candidate.update({ where: { id: ids.candidateId }, data: { email: opts.email } });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'DO_NOT_PROGRESS',
      confidence: 0.7, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT),
    },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, assessmentId: assessment.id, auth };
}

async function setPolicy(tenantId: string, patch: Record<string, unknown>) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { policyJson: true } });
  const policy = { ...(JSON.parse(tenant.policyJson) as Record<string, unknown>), ...patch };
  await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: JSON.stringify(policy) } });
}

async function rowFor(sessionId: string) {
  return prisma.candidateFeedbackEmail.findUniqueOrThrow({ where: { sessionId } });
}

const LATER = () => new Date(Date.now() + 2 * 60 * 60_000);

beforeEach(async () => {
  await wipe();
  mail.sent = [];
  mail.failNext = 0;
  mail.delivers = true;
  mail.hold = null;
  mail.started = null;
  _setFeedbackSendTimeoutForTest(null);
  llm.reply = JSON.stringify(MODEL_CONTENT);
  llm.calls = 0;
  llm.hold = null;
  llm.started = null;
  _resetLlm();
});

describe('queueing when the assessment is stored', () => {
  it('queues one feedback email for a completed interview', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    expect((await rowFor(ids.sessionId)).status).toBe('QUEUED');
  });

  it('creates a single row when finalisation queues it twice at once', async () => {
    const ids = await completedInterview();
    await Promise.all([1, 2, 3].map(() => enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId })));
    expect(await prisma.candidateFeedbackEmail.count({ where: { sessionId: ids.sessionId } })).toBe(1);
  });

  it('records a skip, not a send, when the organisation switched it off', async () => {
    const ids = await completedInterview();
    await setPolicy(ids.tenantId, { autoCandidateFeedback: false });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    expect(await rowFor(ids.sessionId)).toMatchObject({ status: 'SKIPPED', skipReason: 'POLICY_OFF' });
  });

  it('records a skip for a partial interview a reviewer chose to score', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId, partial: true });
    expect(await rowFor(ids.sessionId)).toMatchObject({ status: 'SKIPPED', skipReason: 'PARTIAL_INTERVIEW' });
  });
});

/**
 * The owner's rule: the hiring team has a window to review, the candidate
 * hears the moment a review lands, and nobody waits on a review that never
 * comes.
 */
describe('when the letter goes', () => {
  const HOURS = 60 * 60_000;
  const hoursFromNow = (h: number) => new Date(Date.now() + h * HOURS);

  async function completeReview(ids: Awaited<ReturnType<typeof completedInterview>>, overrides: unknown[] = []) {
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/review`).set(ids.auth)
      .send({ disposition: 'CONSIDER', reason: 'Read the transcript myself.', overrides });
    expect(res.status).toBe(201);
    return res;
  }

  it('does not send while the hiring team still has time to review', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    await deliverDueFeedbackEmails(hoursFromNow(11));

    expect({ sent: mail.sent.length, status: (await rowFor(ids.sessionId)).status }).toEqual({ sent: 0, status: 'QUEUED' });
  });

  it('waits twelve hours by default', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    const due = (await rowFor(ids.sessionId)).nextAttemptAt?.getTime() ?? 0;

    expect(Math.round((due - Date.now()) / HOURS)).toBe(12);
  });

  it('sends as soon as a reviewer completes their review', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    await completeReview(ids);
    await deliverDueFeedbackEmails(new Date());

    expect({ sent: mail.sent.length, row: await rowFor(ids.sessionId) })
      .toMatchObject({ sent: 1, row: { status: 'SENT', releaseReason: 'review' } });
  });

  it('lets a review at the eleventh hour win', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    await deliverDueFeedbackEmails(hoursFromNow(11.983)); // 11h59
    expect(mail.sent).toHaveLength(0);
    await completeReview(ids);
    await deliverDueFeedbackEmails(hoursFromNow(11.984));

    expect((await rowFor(ids.sessionId)).releaseReason).toBe('review');
  });

  it('sends once the window has passed with no review', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    await deliverDueFeedbackEmails(hoursFromNow(12.5));

    expect({ sent: mail.sent.length, row: await rowFor(ids.sessionId) })
      .toMatchObject({ sent: 1, row: { status: 'SENT', releaseReason: 'window' } });
  });

  it('does not send a second letter when a review lands afterwards', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(hoursFromNow(12.5));

    await completeReview(ids);
    await deliverDueFeedbackEmails(hoursFromNow(13));

    expect({ sent: mail.sent.length, status: (await rowFor(ids.sessionId)).status }).toEqual({ sent: 1, status: 'SENT' });
  });

  it("writes the letter from the reviewer's own reading of the interview", async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    // The reviewer thought the candidate handled stakeholders far better than
    // the AI did; the candidate should be told that, not the AI's version.
    await completeReview(ids, [{ competencyId: 'stake', from: 2, to: 5, reason: 'Clear in the second half.' }]);
    await deliverDueFeedbackEmails(new Date());

    expect(mail.sent[0].text).toContain('Stakeholder management: Clear strength');
  });

  it('writes it again when a review changes the picture after it was prepared', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    // Someone looks at the preview first, which stores the AI's version.
    const preview = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/preview`).set(ids.auth).send({});
    expect(preview.body.preview.text).toContain('Stakeholder management: Partly shown');

    await completeReview(ids, [{ competencyId: 'stake', from: 2, to: 5, reason: 'Clear in the second half.' }]);
    await deliverDueFeedbackEmails(new Date());

    expect((await rowFor(ids.sessionId)).bodyText).toContain('Stakeholder management: Clear strength');
  });

  it('honours an organisation that wants a different window', async () => {
    const ids = await completedInterview({ windowHours: 2 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    await deliverDueFeedbackEmails(hoursFromNow(3));

    expect(mail.sent).toHaveLength(1);
  });

  // The window ran out and the send is already under way when the reviewer
  // finishes. Their reading must still be the one the candidate receives.
  it('sends the reviewed content when a review lands while the letter is being written', async () => {
    let release = () => {};
    llm.hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { llm.started = resolve; });
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const queued = await rowFor(ids.sessionId);

    const inFlight = attemptFeedbackEmail(queued.id, hoursFromNow(13));
    await started;
    await completeReview(ids, [{ competencyId: 'stake', from: 2, to: 5, reason: 'Clear in the second half.' }]);
    release();
    llm.hold = null;
    await inFlight;

    expect({ sent: mail.sent.length, text: mail.sent[0]?.text ?? '', row: await rowFor(ids.sessionId) })
      .toMatchObject({ sent: 1, text: expect.stringContaining('Stakeholder management: Clear strength'), row: { status: 'SENT' } });
  });

  it("pins the letter to the review it was written from", async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const res = await completeReview(ids);
    await deliverDueFeedbackEmails(new Date());
    expect((await rowFor(ids.sessionId)).contentBasis).toBe(`review:${res.body.review.id}`);
  });

  // The reviewer was quicker than the finalisation's own bookkeeping.
  it('goes at once when the review was completed before the letter was even queued', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await completeReview(ids);

    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const row = await rowFor(ids.sessionId);

    expect({ release: row.releaseReason, due: (row.nextAttemptAt?.getTime() ?? Infinity) <= Date.now() })
      .toEqual({ release: 'review', due: true });
  });

  it('sends by hand without waiting for the window at all', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});

    expect({ status: res.status, sent: mail.sent.length, release: (await rowFor(ids.sessionId)).releaseReason })
      .toEqual({ status: 200, sent: 1, release: 'manual' });
  });
});

/**
 * Rows queued before the review window existed were due at once. Left alone,
 * every one of them would fire on the first tick after deploy.
 */
describe('letters queued before the review window existed', () => {
  async function legacyRow(ids: Awaited<ReturnType<typeof completedInterview>>) {
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const row = await rowFor(ids.sessionId);
    // As f19e753 wrote them: due the moment they were created.
    await prisma.candidateFeedbackEmail.update({ where: { id: row.id }, data: { nextAttemptAt: row.createdAt } });
    return row;
  }

  it('are moved to the end of the window at start-up', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    const row = await legacyRow(ids);

    const moved = await rescheduleLegacyFeedbackEmails();
    const due = (await rowFor(ids.sessionId)).nextAttemptAt?.getTime() ?? 0;

    expect({ moved, hours: Math.round((due - row.createdAt.getTime()) / (60 * 60_000)) }).toEqual({ moved: 1, hours: 12 });
  });

  it('are not moved twice', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    await legacyRow(ids);
    await rescheduleLegacyFeedbackEmails();
    expect(await rescheduleLegacyFeedbackEmails()).toBe(0);
  });

  it('leaves a letter a reviewer or a person already released alone', async () => {
    const ids = await completedInterview({ windowHours: 12 });
    const row = await legacyRow(ids);
    await prisma.candidateFeedbackEmail.update({ where: { id: row.id }, data: { releaseReason: 'review' } });
    expect(await rescheduleLegacyFeedbackEmails()).toBe(0);
  });

  it('leaves an organisation with no window alone', async () => {
    const ids = await completedInterview({ windowHours: 0 });
    await legacyRow(ids);
    expect(await rescheduleLegacyFeedbackEmails()).toBe(0);
  });
});

describe('sending from the background job', () => {
  it('emails the candidate', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect(mail.sent.map((m) => m.to)).toEqual(['priya.sharma@example.com']);
  });

  it('records the exact text that was sent', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    const row = await rowFor(ids.sessionId);
    const link = /https?:\/\/\S+\/talk-to-a-person\/\S+/;
    expect(row.bodyText).toBe(mail.sent[0].text.replace(link, TALK_LINK_PLACEHOLDER));
  });

  it('marks the row sent with the time it went', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    const row = await rowFor(ids.sessionId);
    expect({ status: row.status, delivered: row.delivered, sent: row.sentAt instanceof Date }).toEqual({ status: 'SENT', delivered: true, sent: true });
  });

  it('never stores the working talk link', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect((await rowFor(ids.sessionId)).bodyText).not.toMatch(/talk-to-a-person\//);
  });

  it('uses the model wording when it passes the checks', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect(mail.sent[0].text).toContain(MODEL_CONTENT.swot.strengths[0]);
  });

  it('falls back to evidence wording when the model mentions a score', async () => {
    llm.reply = JSON.stringify({ ...MODEL_CONTENT, swot: { ...MODEL_CONTENT.swot, strengths: ['You scored 4 out of 5 on SQL, which is excellent work.', MODEL_CONTENT.swot.strengths[1]] } });
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect((await rowFor(ids.sessionId)).contentSource).toBe('evidence');
  });

  it('carries no score, recommendation or decision', async () => {
    llm.reply = 'not json at all';
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    const prose = mail.sent[0].text.replace(/"[^"]*"/g, '""');
    expect(prose).not.toMatch(/\b(score|scored|41|recommend\w*|DO_NOT_PROGRESS|progress(ed|ing)|reject\w*|level)\b|\d+\s*\/\s*\d+/i);
  });

  it('sends exactly once when several workers race for the same email', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const row = await rowFor(ids.sessionId);
    await Promise.all([1, 2, 3, 4, 5].map(() => attemptFeedbackEmail(row.id, LATER())));
    expect(mail.sent).toHaveLength(1);
  });

  it('does not send again once sent', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    await deliverDueFeedbackEmails(LATER());
    expect(mail.sent).toHaveLength(1);
  });

  it('records a send the server could only log as sent but not delivered', async () => {
    mail.delivers = false;
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect(await rowFor(ids.sessionId)).toMatchObject({ status: 'SENT', delivered: false });
  });
});

describe('skip rules, checked again when sending', () => {
  it.each([
    ['a withdrawn interview', { state: 'CANDIDATE_WITHDREW' }, 'WITHDRAWN'],
    ['an interview that failed technically', { state: 'TECHNICAL_FAILURE' }, 'NOT_COMPLETED'],
    ['a candidate with no email', { email: '' }, 'NO_EMAIL'],
  ] as const)('skips %s', async (_label, opts, reason) => {
    const ids = await completedInterview(opts);
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect({ row: await rowFor(ids.sessionId), sent: mail.sent.length })
      .toMatchObject({ row: { status: 'SKIPPED', skipReason: reason }, sent: 0 });
  });

  it('honours a candidate who said no to written feedback', async () => {
    const ids = await completedInterview();
    await prisma.candidateFeedbackOptIn.create({ data: { sessionId: ids.sessionId, candidateId: ids.candidateId, tenantId: ids.tenantId, choice: 'NO' } });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect(await rowFor(ids.sessionId)).toMatchObject({ status: 'SKIPPED', skipReason: 'DECLINED' });
  });

  it('does not email a stranger from a demo', async () => {
    const ids = await completedInterview({ isDemo: true });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect(await rowFor(ids.sessionId)).toMatchObject({ status: 'SKIPPED', skipReason: 'DEMO_RECIPIENT' });
  });

  it('never spends on the paid model for a demo', async () => {
    const ids = await completedInterview({ isDemo: true, email: 'demo@questor.local' });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    expect({ calls: llm.calls, row: await rowFor(ids.sessionId) }).toMatchObject({ calls: 0, row: { status: 'SENT', contentSource: 'evidence' } });
  });
});

describe('retries', () => {
  it('queues a retry with the error recorded when the mail server refuses', async () => {
    mail.failNext = 1;
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const now = new Date();
    await deliverDueFeedbackEmails(now);
    const row = await rowFor(ids.sessionId);
    expect({ status: row.status, attempts: row.attempts, error: row.lastError, later: (row.nextAttemptAt?.getTime() ?? 0) > now.getTime() })
      .toEqual({ status: 'QUEUED', attempts: 1, error: 'SMTP 451 try again later', later: true });
  });

  it('does not retry before the backoff has passed', async () => {
    mail.failNext = 1;
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const now = new Date();
    await deliverDueFeedbackEmails(now);
    await deliverDueFeedbackEmails(now);
    expect(mail.sent).toHaveLength(0);
  });

  it('sends on a later attempt with the same words', async () => {
    mail.failNext = 1;
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(new Date());
    const before = (await rowFor(ids.sessionId)).bodyText;
    llm.reply = JSON.stringify({ ...MODEL_CONTENT, nextSteps: ['A different step that would only appear if the text were written again.', MODEL_CONTENT.nextSteps[1], MODEL_CONTENT.nextSteps[2]] });
    await deliverDueFeedbackEmails(LATER());
    expect({ status: (await rowFor(ids.sessionId)).status, same: (await rowFor(ids.sessionId)).bodyText === before })
      .toEqual({ status: 'SENT', same: true });
  });

  it('gives up and marks the email failed after the last attempt', async () => {
    mail.failNext = MAX_SEND_ATTEMPTS;
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    let now = Date.now();
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      now += 2 * 60 * 60_000;
      await deliverDueFeedbackEmails(new Date(now));
    }
    expect(await rowFor(ids.sessionId)).toMatchObject({ status: 'FAILED', attempts: MAX_SEND_ATTEMPTS });
  });

  it('gives up on a provider that never answers, and says so', async () => {
    _setFeedbackSendTimeoutForTest(50);
    let release = () => {};
    mail.hold = new Promise<void>((resolve) => { release = resolve; });
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

    await deliverDueFeedbackEmails(LATER());
    const row = await rowFor(ids.sessionId);
    release();
    mail.hold = null;

    expect({ status: row.status, attempts: row.attempts, error: row.lastError })
      .toEqual({ status: 'QUEUED', attempts: 1, error: expect.stringMatching(/did not answer/i) });
  });

  // The stall the sweeper is for, run for real: the send is still in flight
  // when its claim is taken, and the email then goes out. Recording that as
  // FAILED would invite a person to send the candidate a second copy.
  it('records a send whose claim was taken mid-flight as unconfirmed, not failed', async () => {
    let release = () => {};
    mail.hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { mail.started = resolve; });
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const queued = await rowFor(ids.sessionId);

    const inFlight = attemptFeedbackEmail(queued.id, LATER());
    await started;
    // The claim looks abandoned to another instance, which releases it.
    await prisma.candidateFeedbackEmail.update({
      where: { id: queued.id }, data: { claimedAt: new Date(Date.now() - FEEDBACK_SEND_STALE_MS - 1000) },
    });
    await deliverDueFeedbackEmails(new Date());
    expect((await rowFor(ids.sessionId)).status).toBe('FAILED');
    release();
    mail.hold = null;
    await inFlight;

    const row = await rowFor(ids.sessionId);
    expect({ status: row.status, sent: mail.sent.length, sentAt: row.sentAt instanceof Date })
      .toEqual({ status: 'SENT_UNVERIFIED', sent: 1, sentAt: true });
  });

  it('keeps the text of an unconfirmed send so a person can see what went', async () => {
    let release = () => {};
    mail.hold = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { mail.started = resolve; });
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const queued = await rowFor(ids.sessionId);

    const inFlight = attemptFeedbackEmail(queued.id, LATER());
    await started;
    await prisma.candidateFeedbackEmail.update({
      where: { id: queued.id }, data: { claimedAt: new Date(Date.now() - FEEDBACK_SEND_STALE_MS - 1000) },
    });
    await deliverDueFeedbackEmails(new Date());
    release();
    mail.hold = null;
    await inFlight;

    expect((await rowFor(ids.sessionId)).bodyText).toContain('Hi Priya,');
  });

  it('marks a send interrupted mid-way as failed rather than sending twice', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const row = await rowFor(ids.sessionId);
    await prisma.candidateFeedbackEmail.update({ where: { id: row.id }, data: { status: 'SENDING', claimedAt: new Date(Date.now() - FEEDBACK_SEND_STALE_MS - 1000) } });
    await deliverDueFeedbackEmails(new Date());
    expect({ status: (await rowFor(ids.sessionId)).status, sent: mail.sent.length }).toEqual({ status: 'FAILED', sent: 0 });
  });
});

describe('the assessment page', () => {
  it('shows what was sent and when', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await deliverDueFeedbackEmails(LATER());
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/feedback-email`).set(ids.auth);
    expect({ status: res.status, email: res.body.email?.status, text: res.body.email?.bodyText })
      .toEqual({ status: 200, email: 'SENT', text: (await rowFor(ids.sessionId)).bodyText });
  });

  it('offers "Send feedback now" for a completed interview with nothing sent', async () => {
    const ids = await completedInterview();
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/feedback-email`).set(ids.auth);
    expect({ email: res.body.email, canSendNow: res.body.canSendNow }).toEqual({ email: null, canSendNow: true });
  });

  it('previews the email before sending', async () => {
    const ids = await completedInterview();
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/preview`).set(ids.auth).send({});
    expect({ status: res.status, subject: res.body.preview?.subject }).toEqual({
      status: 200, subject: expect.stringMatching(/^Your interview feedback — .+ at Acme Corp$/),
    });
  });

  it('sends by hand the text that was previewed', async () => {
    const ids = await completedInterview();
    const preview = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/preview`).set(ids.auth).send({});
    llm.reply = JSON.stringify({ ...MODEL_CONTENT, nextSteps: ['A different step that would only appear if the text were written again.', MODEL_CONTENT.nextSteps[1], MODEL_CONTENT.nextSteps[2]] });
    const sent = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect({ status: sent.status, email: sent.body.email?.status, same: sent.body.email?.bodyText === preview.body.preview.text })
      .toEqual({ status: 200, email: 'SENT', same: true });
  });

  it('sends once however many times the button is pressed', async () => {
    const ids = await completedInterview();
    const presses = await Promise.all([1, 2, 3, 4, 5, 6].map(() => request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({})));
    expect({ sent: mail.sent.length, ok: presses.filter((r) => r.status === 200).length }).toEqual({ sent: 1, ok: 1 });
  });

  it('refuses a second send once the feedback has gone', async () => {
    const ids = await completedInterview();
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    const again = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect({ status: again.status, sent: mail.sent.length }).toEqual({ status: 409, sent: 1 });
  });

  it('sends by hand after the automatic email failed', async () => {
    mail.failNext = MAX_SEND_ATTEMPTS;
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await prisma.candidateFeedbackEmail.update({ where: { sessionId: ids.sessionId }, data: { status: 'FAILED', attempts: MAX_SEND_ATTEMPTS } });
    mail.failNext = 0;
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect({ status: res.status, email: res.body.email?.status }).toEqual({ status: 200, email: 'SENT' });
  });

  it('sends by hand when the automatic email was switched off at the time', async () => {
    const ids = await completedInterview();
    await setPolicy(ids.tenantId, { autoCandidateFeedback: false });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect({ status: res.status, sent: mail.sent.length }).toEqual({ status: 200, sent: 1 });
  });

  it('refuses to send by hand for a withdrawn interview', async () => {
    const ids = await completedInterview({ state: 'CANDIDATE_WITHDREW' });
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect({ status: res.status, sent: mail.sent.length }).toEqual({ status: 409, sent: 0 });
  });

  it('refuses to send by hand for a partial interview a reviewer chose to score', async () => {
    const ids = await completedInterview();
    await prisma.auditEvent.create({ data: { tenantId: ids.tenantId, actorType: 'user', actorId: ids.userId, action: 'interview.assess_partial', entityType: 'InterviewSession', entityId: ids.sessionId } });
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect(res.status).toBe(409);
  });

  it('keeps sending to people who may review', async () => {
    const ids = await completedInterview();
    const recruiter = await prisma.user.create({ data: { tenantId: ids.tenantId, email: 'rec@acme.test', name: 'Rec', passwordHash: 'x', role: 'recruiter' } });
    const auth = { Authorization: `Bearer ${signToken({ userId: recruiter.id, tenantId: ids.tenantId, role: 'recruiter', email: recruiter.email })}` };
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(auth).send({});
    expect({ status: res.status, sent: mail.sent.length }).toEqual({ status: 403, sent: 0 });
  });

  it('refuses to resend an unconfirmed send without someone accepting the risk', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await prisma.candidateFeedbackEmail.update({ where: { sessionId: ids.sessionId }, data: { status: 'SENT_UNVERIFIED', bodyText: 'Hi Priya,' } });

    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});

    expect({ status: res.status, sent: mail.sent.length, reason: res.body.error })
      .toEqual({ status: 409, sent: 0, reason: expect.stringMatching(/may already have reached the candidate/i) });
  });

  it('tells the page that this one needs the risk accepted', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await prisma.candidateFeedbackEmail.update({ where: { sessionId: ids.sessionId }, data: { status: 'SENT_UNVERIFIED' } });

    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/feedback-email`).set(ids.auth);

    expect({ canSendNow: res.body.canSendNow, needsConfirmation: res.body.needsDuplicateConfirmation })
      .toEqual({ canSendNow: false, needsConfirmation: true });
  });

  it('sends an unconfirmed one again when the risk is accepted', async () => {
    const ids = await completedInterview();
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });
    await prisma.candidateFeedbackEmail.update({ where: { sessionId: ids.sessionId }, data: { status: 'SENT_UNVERIFIED' } });

    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth)
      .send({ confirmPossibleDuplicate: true });

    expect({ status: res.status, email: res.body.email?.status, sent: mail.sent.length })
      .toEqual({ status: 200, email: 'SENT', sent: 1 });
  });

  it('refuses a body it does not expect', async () => {
    const ids = await completedInterview();
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({ to: 'someone@else.test' });
    expect(res.status).toBe(400);
  });
});
