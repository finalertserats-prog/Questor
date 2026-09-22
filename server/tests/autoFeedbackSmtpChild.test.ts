import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFastSmtpServer, startTricklingSmtpServer, type FakeSmtpServer } from './fakeSmtpServer.js';

/**
 * The candidate's feedback email over a real SMTP conversation, with the send
 * in the child process that the deadline can kill.
 *
 * This is the join the owner's rule depends on: a send that had to be killed
 * is an unknown outcome, so the row says SENT_UNVERIFIED and the lock stands
 * until it expires — no review may be completed while a socket may still be
 * open. A send that finished is a known one, so the row says SENT and the lock
 * goes at once.
 */

const smtp = vi.hoisted(() => ({ provider: null as { name: string } | null }));

vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return { ...actual, getEmail: () => smtp.provider ?? actual.getEmail() };
});

const { prisma } = await import('../src/db.js');
const { createDemoData, wipe } = await import('../src/seed/demoData.js');
const { createSmtpProvider } = await import('../src/providers/email/index.js');
const { attemptFeedbackEmail, enqueueAutoFeedback } = await import('../src/services/autoFeedback.js');

const RESULT = {
  assessmentVersion: 'A-1', roleScorecardVersion: 's', recommendation: 'DO_NOT_PROGRESS', confidence: 0.7,
  evidenceCoverage: 0.6, overallScore: 41,
  competencies: [
    {
      id: 'sql', name: 'SQL', level: 4, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false, rationale: '', rubricVersion: 'r',
      evidence: [{ turnId: 't1', startMs: 0, endMs: 1, quote: 'I rewrote the billing query with a window function and it ran in seconds.' }],
    },
  ],
  strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'Scored 41/100.',
};

async function setReviewWindowToZero(tenantId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { policyJson: true } });
  const policy = { ...(JSON.parse(tenant.policyJson) as Record<string, unknown>), feedbackReviewWindowHours: 0 };
  await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: JSON.stringify(policy) } });
}

async function queuedFeedback() {
  const ids = await createDemoData();
  await setReviewWindowToZero(ids.tenantId);
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'DO_NOT_PROGRESS',
      confidence: 0.7, evidenceCoverage: 0.6, resultJson: JSON.stringify(RESULT),
    },
  });
  const row = await enqueueAutoFeedback({ sessionId: ids.sessionId, assessmentId: assessment.id });
  if (!row) throw new Error('The feedback email was not queued');
  return { ...ids, feedbackEmailId: row.id };
}

describe('the feedback email sent over SMTP', () => {
  let mailServer: FakeSmtpServer | null = null;

  beforeEach(async () => {
    await wipe();
    smtp.provider = null;
  });

  afterEach(async () => {
    await mailServer?.close();
    mailServer = null;
  });

  it('records a killed send as unconfirmed and keeps the send lock', async () => {
    // A relay that keeps talking without finishing: no transport timeout can
    // fire, so the deadline and the kill are what end this send.
    mailServer = await startTricklingSmtpServer({ byteEveryMs: 150 });
    smtp.provider = createSmtpProvider({ host: '127.0.0.1', port: mailServer.port, user: 'u', pass: 'p' }, { deadlineMs: 1_500 });
    const ids = await queuedFeedback();

    const outcome = await attemptFeedbackEmail(ids.feedbackEmailId);
    const row = await prisma.candidateFeedbackEmail.findUniqueOrThrow({ where: { id: ids.feedbackEmailId } });

    expect({
      outcome,
      status: row.status,
      lockHeld: (row.sendLockUntil?.getTime() ?? 0) > Date.now(),
      accepted: mailServer.sawDataTerminator(),
    }).toEqual({ outcome: 'sent-unverified', status: 'SENT_UNVERIFIED', lockHeld: true, accepted: false });
  }, 30_000);

  it('records a finished send as sent and lets the lock go', async () => {
    mailServer = await startFastSmtpServer();
    smtp.provider = createSmtpProvider({ host: '127.0.0.1', port: mailServer.port, user: 'u', pass: 'p' }, { deadlineMs: 20_000 });
    const ids = await queuedFeedback();

    const outcome = await attemptFeedbackEmail(ids.feedbackEmailId);
    const row = await prisma.candidateFeedbackEmail.findUniqueOrThrow({ where: { id: ids.feedbackEmailId } });

    expect({ outcome, status: row.status, lock: row.sendLockUntil, accepted: mailServer.sawDataTerminator() })
      .toEqual({ outcome: 'sent', status: 'SENT', lock: null, accepted: true });
  }, 30_000);
});
