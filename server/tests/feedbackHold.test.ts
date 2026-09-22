import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * Holding the candidate's automatic feedback email when the interview is not
 * trustworthy (owner, 2026-09-22): low AI confidence, or poor audio/transcript.
 * A held letter never goes on its own; a person with assessment:review sends
 * it or keeps it held, and both are on the audit trail. Normal interviews keep
 * the 12-hour automatic send exactly as before.
 */

const mail = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string }> }));

vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  const provider = {
    name: 'fake', configured: true, delivers: true,
    async send(msg: { to: string; subject: string; text: string }) {
      mail.sent.push(msg);
      return { status: 'sent', id: `fake-${mail.sent.length}` };
    },
  };
  return { ...actual, getEmail: () => provider };
});

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { createDemoData, wipe } = await import('../src/seed/demoData.js');
const { signToken } = await import('../src/services/auth.js');
const { deliverDueFeedbackEmails, enqueueAutoFeedback } = await import('../src/services/autoFeedback.js');
const { DEFAULT_REVIEW_WINDOW_HOURS } = await import('../src/services/autoFeedbackModel.js');

const app = createApp();
const HOUR = 60 * 60_000;
const hoursFromNow = (h: number) => new Date(Date.now() + h * HOUR);

const GOOD_ANSWERS = [
  'I rebuilt the billing pipeline in Spark and cut the nightly run from four hours to forty minutes.',
  'We had a schema drift problem, so I added contract tests between the producer and our loaders.',
  'I sat with finance every week to agree what a late invoice meant before we changed the report.',
  'When the migration slipped I told the director early and we cut scope to the two critical feeds.',
];

function result(confidence: number, recommendation = 'CONSIDER') {
  return {
    assessmentVersion: 'A-1', roleScorecardVersion: 's', recommendation, confidence, evidenceCoverage: 0.6, overallScore: 55,
    competencies: [
      { id: 'sql', name: 'SQL', level: 4, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false, rationale: '', rubricVersion: 'r',
        evidence: [{ turnId: 't1', startMs: 0, endMs: 1, quote: 'I rebuilt the billing pipeline in Spark.' }] },
    ],
    strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'Scored 55/100.',
  };
}

async function interview(opts: { confidence?: number; answers?: string[]; reconnects?: number; windowHours?: number } = {}) {
  const ids = await createDemoData();
  if (opts.windowHours !== undefined) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ids.tenantId }, select: { policyJson: true } });
    await prisma.tenant.update({
      where: { id: ids.tenantId },
      data: { policyJson: JSON.stringify({ ...(JSON.parse(tenant.policyJson) as object), feedbackReviewWindowHours: opts.windowHours }) },
    });
  }
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
  const answers = opts.answers ?? GOOD_ANSWERS;
  let index = 0;
  for (const text of answers) {
    await prisma.turn.create({ data: { sessionId: ids.sessionId, index: index++, speaker: 'agent', text: 'Tell me about that.' } });
    await prisma.turn.create({ data: { sessionId: ids.sessionId, index: index++, speaker: 'candidate', text } });
  }
  for (let i = 0; i < (opts.reconnects ?? 0); i++) {
    await prisma.auditEvent.create({
      data: { tenantId: ids.tenantId, actorType: 'system', actorId: 'portal', action: 'interview.rejoined', entityType: 'InterviewSession', entityId: ids.sessionId, afterJson: '{}' },
    });
  }
  const confidence = opts.confidence ?? 0.7;
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'CONSIDER',
      confidence, evidenceCoverage: 0.6, resultJson: JSON.stringify(result(confidence)),
    },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  /** A colleague with this role, assigned to the candidate so object scope lets them in. */
  const tokenFor = async (role: string) => {
    const email = `${role}@held.local`;
    const user = await prisma.user.create({ data: { tenantId: ids.tenantId, email, name: role, passwordHash: 'x', role } });
    await prisma.candidateAssignment.create({ data: { candidateId: ids.candidateId, userId: user.id, relation: 'owner' } });
    return { Authorization: `Bearer ${signToken({ userId: user.id, tenantId: ids.tenantId, role, email })}` };
  };
  return { ...ids, assessmentId: assessment.id, auth, tokenFor };
}

const rowFor = (sessionId: string) => prisma.candidateFeedbackEmail.findUniqueOrThrow({ where: { sessionId } });
const auditActions = async (sessionId: string) => (await prisma.auditEvent.findMany({ where: { entityId: sessionId }, select: { action: true } })).map((e) => e.action);
const enqueue = (ids: { sessionId: string; assessmentId: string }) => enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId });

beforeEach(async () => {
  await wipe();
  mail.sent = [];
});

describe('a normal interview is not held', () => {
  it('is queued for the 12-hour review window', async () => {
    const ids = await interview();
    const before = Date.now();
    await enqueue(ids);
    const row = await rowFor(ids.sessionId);
    const dueInHours = ((row.nextAttemptAt?.getTime() ?? 0) - before) / HOUR;
    expect({ status: row.status, due: Math.round(dueInHours) }).toEqual({ status: 'QUEUED', due: DEFAULT_REVIEW_WINDOW_HOURS });
  });

  it('is not sent before the window runs out', async () => {
    const ids = await interview();
    await enqueue(ids);
    await deliverDueFeedbackEmails(hoursFromNow(11));
    expect(mail.sent).toHaveLength(0);
  });

  it('is sent on its own once the window runs out', async () => {
    const ids = await interview();
    await enqueue(ids);
    await deliverDueFeedbackEmails(hoursFromNow(12.5));
    expect(mail.sent).toHaveLength(1);
  });

  it('carries no hold record', async () => {
    const ids = await interview();
    await enqueue(ids);
    expect((await rowFor(ids.sessionId)).holdJson).toBe('');
  });
});

describe('an untrustworthy interview is held', () => {
  it('holds when the AI confidence is low', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    expect((await rowFor(ids.sessionId)).status).toBe('HELD');
  });

  it('records the reasons with the letter', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    expect(JSON.parse((await rowFor(ids.sessionId)).holdJson).reasons).toEqual(['LOW_AI_CONFIDENCE']);
  });

  it('holds when the transcript lost the candidate’s words', async () => {
    const ids = await interview({ answers: ['No', '', 'Oh', GOOD_ANSWERS[0], 'hmm'] });
    await enqueue(ids);
    expect(JSON.parse((await rowFor(ids.sessionId)).holdJson).reasons).toEqual(['UNUSABLE_REPLIES']);
  });

  it('holds when the connection kept dropping', async () => {
    const ids = await interview({ reconnects: 3 });
    await enqueue(ids);
    expect(JSON.parse((await rowFor(ids.sessionId)).holdJson).reasons).toEqual(['RECONNECTS']);
  });

  it('never sends a held letter on its own, however long it waits', async () => {
    const ids = await interview({ confidence: 0.25, windowHours: 0 });
    await enqueue(ids);
    await deliverDueFeedbackEmails(hoursFromNow(24 * 30));
    expect(mail.sent).toHaveLength(0);
  });

  it('writes the hold to the audit trail', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    expect(await auditActions(ids.sessionId)).toContain('feedback.email.held');
  });

  it('is not released by a completed review', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await request(app).post(`/api/assessments/${ids.assessmentId}/review`).set(ids.auth)
      .send({ verdict: 'CONSIDER', reason: 'Read the transcript myself.', overrides: [] });
    await deliverDueFeedbackEmails(hoursFromNow(1));
    expect({ status: (await rowFor(ids.sessionId)).status, sent: mail.sent.length }).toEqual({ status: 'HELD', sent: 0 });
  });

  it('does not hold an interview that is skipped anyway', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: ids.assessmentId, partial: true });
    expect((await rowFor(ids.sessionId)).status).toBe('SKIPPED');
  });
});

describe('the assessment page', () => {
  it('shows the reasons in plain words', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/feedback-email`).set(ids.auth);
    expect(res.body.email.hold.reasonTexts[0]).toContain('25%');
  });

  it('offers the decision to someone who may review', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/feedback-email`).set(await ids.tokenFor('reviewer'));
    expect(res.body.canDecideHold).toBe(true);
  });

  it('shows the hold but not the decision to a recruiter', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).get(`/api/assessments/${ids.assessmentId}/feedback-email`).set(await ids.tokenFor('recruiter'));
    expect({ held: res.body.email.status, canDecide: res.body.canDecideHold }).toEqual({ held: 'HELD', canDecide: false });
  });
});

describe('releasing a held letter', () => {
  it('sends it when a reviewer releases it', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect(mail.sent).toHaveLength(1);
  });

  it('says it was released from hold', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect(res.body.email.releaseReason).toBe('hold_released');
  });

  it('keeps the reasons on record after release', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect(JSON.parse((await rowFor(ids.sessionId)).holdJson).reasons).toEqual(['LOW_AI_CONFIDENCE']);
  });

  it('writes the release to the audit trail', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect(await auditActions(ids.sessionId)).toContain('feedback.email.hold_released');
  });

  it('refuses a recruiter, who may not send feedback', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(await ids.tokenFor('recruiter')).send({});
    expect({ status: res.status, sent: mail.sent.length }).toEqual({ status: 403, sent: 0 });
  });
});

describe('keeping a letter held', () => {
  const keep = (ids: { assessmentId: string }, auth: Record<string, string>) =>
    request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/hold`).set(auth).send({});

  it('keeps it unsent', async () => {
    const ids = await interview({ confidence: 0.25, windowHours: 0 });
    await enqueue(ids);
    await keep(ids, ids.auth);
    await deliverDueFeedbackEmails(hoursFromNow(48));
    expect({ status: (await rowFor(ids.sessionId)).status, sent: mail.sent.length }).toEqual({ status: 'HELD', sent: 0 });
  });

  it('records who decided', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await keep(ids, ids.auth);
    expect(res.body.email.hold.keptByUserId).toBe(ids.userId);
  });

  it('writes the decision to the audit trail', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await keep(ids, ids.auth);
    expect(await auditActions(ids.sessionId)).toContain('feedback.email.hold_kept');
  });

  it('can still be released afterwards', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await keep(ids, ids.auth);
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/send`).set(ids.auth).send({});
    expect(mail.sent).toHaveLength(1);
  });

  it('does not let a second keep overwrite who decided first', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await keep(ids, ids.auth);
    const second = await keep(ids, await ids.tokenFor('reviewer'));
    expect({ status: second.status, keptBy: (await rowFor(ids.sessionId)).holdKeptByUserId }).toEqual({ status: 409, keptBy: ids.userId });
  });

  it('refuses a letter that is not held', async () => {
    const ids = await interview();
    await enqueue(ids);
    expect((await keep(ids, ids.auth)).status).toBe(409);
  });

  it('refuses a recruiter', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    expect((await keep(ids, await ids.tokenFor('recruiter'))).status).toBe(403);
  });

  it('refuses a body, since nothing about the decision comes from the request', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/hold`).set(ids.auth).send({ userId: 'someone' });
    expect(res.status).toBe(400);
  });
});

describe('needs attention and the held list', () => {
  it('counts a held letter in the dashboard’s needs-attention', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).get('/api/dashboard/metrics').set(ids.auth);
    expect(res.body.needsAttention.counts.feedback_held).toBe(1);
  });

  it('lists it as an item that links to its assessment', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).get('/api/dashboard/metrics').set(ids.auth);
    const item = (res.body.needsAttention.items as Array<{ kind: string; assessmentId: string }>).find((i) => i.kind === 'feedback_held');
    expect(item?.assessmentId).toBe(ids.assessmentId);
  });

  it('stops asking once someone keeps it held', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/hold`).set(ids.auth).send({});
    const res = await request(app).get('/api/dashboard/metrics').set(ids.auth);
    expect(res.body.needsAttention.counts.feedback_held).toBe(0);
  });

  it('lists held letters with their reasons for an inbox', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).get('/api/dashboard/held-feedback').set(ids.auth);
    expect({ total: res.body.total, reasons: res.body.items[0].reasons }).toEqual({ total: 1, reasons: ['LOW_AI_CONFIDENCE'] });
  });

  it('includes kept letters in the list only when asked', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    await request(app).post(`/api/assessments/${ids.assessmentId}/feedback-email/hold`).set(ids.auth).send({});
    const [awaiting, all] = await Promise.all([
      request(app).get('/api/dashboard/held-feedback').set(ids.auth),
      request(app).get('/api/dashboard/held-feedback?includeKept=true').set(ids.auth),
    ]);
    expect([awaiting.body.total, all.body.total]).toEqual([0, 1]);
  });

  it('hides a held letter from a recruiter not assigned to the candidate', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const other = await prisma.user.create({ data: { tenantId: ids.tenantId, email: 'other@held.local', name: 'Other', passwordHash: 'x', role: 'recruiter' } });
    const res = await request(app).get('/api/dashboard/held-feedback')
      .set('Authorization', `Bearer ${signToken({ userId: other.id, tenantId: ids.tenantId, role: 'recruiter', email: 'other@held.local' })}`);
    expect(res.body.total).toBe(0);
  });

  it('refuses the list to a role that cannot read assessments', async () => {
    const ids = await interview({ confidence: 0.25 });
    await enqueue(ids);
    const res = await request(app).get('/api/dashboard/held-feedback').set(await ids.tokenFor('auditor'));
    expect(res.status).toBe(403);
  });
});
