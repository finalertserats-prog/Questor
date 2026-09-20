import { CorruptRecordError, parseJson, parseJsonStrict, prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import type { AssessmentResult } from '../domain/types.js';
import { getEmail } from '../providers/email/index.js';
import { renderAutoFeedbackEmail } from '../providers/email/autoFeedbackEmail.js';
import { logAudit } from './audit.js';
import { issueHumanRequestToken } from './candidateFeedback.js';
import { autoCandidateFeedbackEnabledForTenant } from './candidateFeedbackPolicy.js';
import { demoRecipientBlocked } from './demoPolicy.js';
import { startJob } from './jobs.js';
import { generateFeedbackContent } from './autoFeedbackContent.js';
import { feedbackContentSchema, type FeedbackContent, type FeedbackContentSource } from './feedbackContentModel.js';
import {
  SKIP_REASON_TEXT, afterFailedAttempt, feedbackEligibility, manualSendAllowed, type FeedbackSkipReason,
} from './autoFeedbackModel.js';

/**
 * The candidate's feedback email, sent automatically once their interview is
 * assessed (owner decision: no human check before it goes).
 *
 * A CandidateFeedbackEmail row is written when the assessment is stored and a
 * background job sends it, so finishing an interview is never slowed by a model
 * call or a mail server, and a restart in between loses nothing. The same
 * pattern as webhook deliveries (webhooks.ts):
 *
 *   - One row per session. A second finalisation or a race finds it and stops.
 *   - A send CLAIMS the row with a conditional update (QUEUED -> SENDING), so
 *     two workers, the job and a "Send feedback now" press, or two instances can never
 *     both send it.
 *   - A failed send goes back to QUEUED with a backoff, and to FAILED after the
 *     last attempt, with the error kept on the row where the hiring team sees it.
 *   - A send that died mid-way (claim older than FEEDBACK_SEND_STALE_MS) is
 *     marked FAILED, NOT retried: the email may already have gone, and a
 *     candidate receiving their feedback twice is worse than a person checking
 *     and pressing "Send feedback now".
 *
 * Every skip rule is checked again at send time, not just at queue time: a
 * candidate can withdraw, say no, or lose their address in between.
 */

export const FEEDBACK_EMAIL_JOB = { name: 'candidate-feedback-email', intervalMs: 15_000, ttlMs: 5 * 60_000, batch: 20 } as const;

/** A claim older than this belongs to a send that died. */
export const FEEDBACK_SEND_STALE_MS = 10 * 60_000;

/** Recorded by POST /interviews/:id/assess-partial; a partial interview is never emailed. */
const ASSESS_PARTIAL_ACTION = 'interview.assess_partial';
const MAX_ERROR_CHARS = 500;
const INTERRUPTED_NOTE = 'The send was interrupted and may or may not have reached the candidate. '
  + 'Check with them before sending again.';

type Outcome = 'not-due' | 'sent' | 'skipped' | 'retry' | 'failed';

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === 'P2002';
}

async function wasScoredPartially(sessionId: string): Promise<boolean> {
  const count = await prisma.auditEvent.count({
    where: { entityType: 'InterviewSession', entityId: sessionId, action: ASSESS_PARTIAL_ACTION },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Queue the email for an interview whose assessment was just stored. Called
 * from finalizeInterview; never sends on the caller's time. The job picks the
 * row up within FEEDBACK_EMAIL_JOB.intervalMs. There is deliberately no
 * "try at once" here: a fire-and-forget send racing the request that ended the
 * interview only competes with it for the database, and nobody is waiting on
 * a feedback email by the second.
 */
export async function enqueueAutoFeedback(opts: {
  sessionId: string;
  assessmentId: string;
  partial?: boolean;
  now?: Date;
}): Promise<{ id: string; created: boolean } | null> {
  const session = await prisma.interviewSession.findUnique({
    where: { id: opts.sessionId }, select: { tenantId: true, candidateId: true },
  });
  if (!session) return null;
  const now = opts.now ?? new Date();

  // Written as a skip rather than not written at all, so the assessment page
  // can say why nothing went and offer to send it by hand.
  let skip: FeedbackSkipReason | null = null;
  if (opts.partial) skip = 'PARTIAL_INTERVIEW';
  else if (!await autoCandidateFeedbackEnabledForTenant(session.tenantId)) skip = 'POLICY_OFF';

  let id: string;
  try {
    const row = await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: opts.sessionId, assessmentId: opts.assessmentId,
        candidateId: session.candidateId, tenantId: session.tenantId, trigger: 'auto',
        status: skip ? 'SKIPPED' : 'QUEUED', skipReason: skip ?? '', nextAttemptAt: skip ? null : now,
      },
    });
    id = row.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await prisma.candidateFeedbackEmail.findUnique({ where: { sessionId: opts.sessionId }, select: { id: true } });
    return existing ? { id: existing.id, created: false } : null;
  }

  if (skip) {
    await logAudit({
      tenantId: session.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
      action: 'feedback.email.skipped', entityType: 'InterviewSession', entityId: opts.sessionId, after: { reason: skip },
    });
  }
  return { id, created: true };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * One attempt at one email. Does nothing unless it wins the claim, so it is
 * safe to call from anywhere, any number of times at once.
 */
export async function attemptFeedbackEmail(id: string, now = new Date()): Promise<Outcome> {
  const claimedAt = now;
  const claim = await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'QUEUED', nextAttemptAt: { lte: now } },
    data: { status: 'SENDING', claimedAt },
  });
  if (claim.count !== 1) return 'not-due';
  try {
    return await sendClaimed(id, claimedAt);
  } catch (err) {
    return recordFailure(id, claimedAt, err);
  }
}

async function loadClaimed(id: string) {
  return prisma.candidateFeedbackEmail.findUniqueOrThrow({
    where: { id },
    include: {
      assessment: { select: { id: true, resultJson: true } },
      session: {
        select: {
          id: true, state: true, completedAt: true, tenantId: true, candidateId: true,
          candidate: { select: { fullName: true, email: true } },
          role: { select: { title: true } },
          tenant: { select: { name: true } },
          feedbackOptIn: { select: { choice: true } },
        },
      },
    },
  });
}

type ClaimedRow = Awaited<ReturnType<typeof loadClaimed>>;

async function skipReasonAtSend(row: ClaimedRow): Promise<FeedbackSkipReason | null> {
  const s = row.session;
  const eligibility = feedbackEligibility({
    state: s.state, completedAt: s.completedAt, partial: await wasScoredPartially(s.id),
    candidateEmail: s.candidate.email, optInChoice: s.feedbackOptIn?.choice ?? null, hasAssessment: true,
  });
  if (!eligibility.eligible) return eligibility.reason;
  // A person pressing "Send feedback now" overrides the switch; the job does not.
  if (row.trigger === 'auto' && !await autoCandidateFeedbackEnabledForTenant(s.tenantId)) return 'POLICY_OFF';
  if (await demoRecipientBlocked(s.tenantId, s.candidate.email)) return 'DEMO_RECIPIENT';
  return null;
}

function storedContent(contentJson: string): FeedbackContent | null {
  if (!contentJson) return null;
  const parsed = feedbackContentSchema.safeParse(parseJson<unknown>(contentJson, null));
  return parsed.success ? parsed.data : null;
}

/**
 * The words to send: the ones already stored (a retry, or what a person
 * previewed), or newly generated. Throws when the assessment cannot be read —
 * feedback built from `{}` would tell the candidate nothing was covered.
 */
async function contentFor(row: {
  contentJson: string; contentSource: string; sessionId: string; assessment: { id: string; resultJson: string };
}): Promise<{ content: FeedbackContent; source: string }> {
  const stored = storedContent(row.contentJson);
  if (stored) return { content: stored, source: row.contentSource };
  let result: AssessmentResult;
  try {
    result = parseJsonStrict<AssessmentResult>(row.assessment.resultJson, { model: 'AssessmentVersion', id: row.assessment.id, field: 'resultJson' });
  } catch (err) {
    if (err instanceof CorruptRecordError) throw new Error('The assessment record could not be read, so no feedback was written.');
    throw err;
  }
  const generated = await generateFeedbackContent(result, row.sessionId);
  return { content: generated.content, source: generated.source };
}

/** The "speak to a person" link. Failing to mint costs the offer, never the email. */
async function talkLink(session: { id: string; candidateId: string; tenantId: string }): Promise<string | null> {
  try {
    const token = await issueHumanRequestToken({ sessionId: session.id, candidateId: session.candidateId, tenantId: session.tenantId });
    return `${config.webOrigin.replace(/\/+$/, '')}/talk-to-a-person/${token}`;
  } catch (err) {
    logger.error({ sessionId: session.id, err: errorText(err) }, 'Could not issue a talk-to-a-person link; the feedback email goes without it');
    return null;
  }
}

async function sendClaimed(id: string, claimedAt: Date): Promise<Outcome> {
  const row = await loadClaimed(id);
  const skip = await skipReasonAtSend(row);
  if (skip) {
    await prisma.candidateFeedbackEmail.updateMany({
      where: { id, status: 'SENDING', claimedAt },
      data: { status: 'SKIPPED', skipReason: skip, claimedAt: null, nextAttemptAt: null },
    });
    await logAudit({
      tenantId: row.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
      action: 'feedback.email.skipped', entityType: 'InterviewSession', entityId: row.sessionId, after: { reason: skip },
    });
    return 'skipped';
  }

  const s = row.session;
  const { content, source } = await contentFor(row);
  const rendered = renderAutoFeedbackEmail({
    to: s.candidate.email, candidateName: s.candidate.fullName, roleTitle: s.role.title,
    companyName: s.tenant.name, content, talkUrl: await talkLink(s),
  });
  // Stored before the send: if the process dies after the mail went, the row
  // still says what went (and the stale-claim sweep marks it for a person).
  await prisma.candidateFeedbackEmail.update({
    where: { id },
    data: { contentJson: JSON.stringify(content), contentSource: source, subject: rendered.message.subject, bodyText: rendered.storedText },
  });

  const email = getEmail();
  await email.send(rendered.message);

  const sentAt = new Date();
  await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'SENDING', claimedAt },
    data: {
      status: 'SENT', sentAt, delivered: email.delivers, attempts: row.attempts + 1,
      lastError: '', claimedAt: null, nextAttemptAt: null,
    },
  });
  await logAudit({
    tenantId: row.tenantId,
    actorType: row.trigger === 'manual' && row.requestedByUserId ? 'user' : 'system',
    actorId: row.trigger === 'manual' && row.requestedByUserId ? row.requestedByUserId : 'candidate-feedback-email',
    action: 'feedback.email.sent', entityType: 'InterviewSession', entityId: row.sessionId,
    after: { assessmentId: row.assessmentId, trigger: row.trigger, contentSource: source, delivered: email.delivers, sentAt },
  });
  return 'sent';
}

async function recordFailure(id: string, claimedAt: Date, err: unknown): Promise<Outcome> {
  const message = errorText(err);
  const row = await prisma.candidateFeedbackEmail.findUnique({ where: { id }, select: { attempts: true, tenantId: true, sessionId: true } });
  if (!row) return 'failed';
  const attempts = row.attempts + 1;
  const next = afterFailedAttempt(attempts, new Date());
  await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'SENDING', claimedAt },
    data: { status: next.status, nextAttemptAt: next.nextAttemptAt, attempts, lastError: message, claimedAt: null },
  });
  if (next.status === 'FAILED') {
    logger.error({ feedbackEmailId: id, attempts, err: message }, 'Candidate feedback email failed after every retry');
    await logAudit({
      tenantId: row.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
      action: 'feedback.email.failed', entityType: 'InterviewSession', entityId: row.sessionId, after: { attempts, error: message },
    });
    return 'failed';
  }
  logger.warn({ feedbackEmailId: id, attempts, err: message }, 'Candidate feedback email failed; will retry');
  return 'retry';
}

/** Mark sends that died mid-way for a person to check. */
async function releaseInterruptedSends(now: Date): Promise<number> {
  const stale = await prisma.candidateFeedbackEmail.findMany({
    where: { status: 'SENDING', claimedAt: { lt: new Date(now.getTime() - FEEDBACK_SEND_STALE_MS) } },
    select: { id: true, claimedAt: true, tenantId: true, sessionId: true },
  });
  let released = 0;
  for (const s of stale) {
    const { count } = await prisma.candidateFeedbackEmail.updateMany({
      where: { id: s.id, status: 'SENDING', claimedAt: s.claimedAt },
      data: { status: 'FAILED', lastError: INTERRUPTED_NOTE, claimedAt: null, nextAttemptAt: null },
    });
    if (count !== 1) continue;
    released += 1;
    logger.error({ feedbackEmailId: s.id }, 'Candidate feedback email send was interrupted; left for a person to check');
    await logAudit({
      tenantId: s.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
      action: 'feedback.email.failed', entityType: 'InterviewSession', entityId: s.sessionId, after: { error: INTERRUPTED_NOTE },
    });
  }
  return released;
}

/** Everything due, for the background job. Returns the note for the job run. */
export async function deliverDueFeedbackEmails(now = new Date()): Promise<string> {
  const interrupted = await releaseInterruptedSends(now);
  const due = await prisma.candidateFeedbackEmail.findMany({
    where: { status: 'QUEUED', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: FEEDBACK_EMAIL_JOB.batch,
    select: { id: true },
  });
  const tally: Record<Outcome, number> = { 'not-due': 0, sent: 0, skipped: 0, retry: 0, failed: 0 };
  for (const d of due) tally[await attemptFeedbackEmail(d.id, now)] += 1;
  return `${due.length} due: ${tally.sent} sent, ${tally.skipped} skipped, ${tally.retry} retrying, ${tally.failed} failed; ${interrupted} interrupted`;
}

export function startFeedbackEmailDelivery(intervalMs: number = FEEDBACK_EMAIL_JOB.intervalMs): () => void {
  return startJob({ name: FEEDBACK_EMAIL_JOB.name, intervalMs, ttlMs: FEEDBACK_EMAIL_JOB.ttlMs, fn: () => deliverDueFeedbackEmails() });
}

// ---------------------------------------------------------------------------
// The assessment page: what was sent, preview, "Send feedback now"
// ---------------------------------------------------------------------------

export interface FeedbackEmailView {
  email: {
    status: string;
    trigger: string;
    skipReason: string;
    skipReasonText: string | null;
    attempts: number;
    lastError: string;
    subject: string;
    bodyText: string;
    contentSource: string;
    delivered: boolean;
    sentAt: Date | null;
    nextAttemptAt: Date | null;
    createdAt: Date;
  } | null;
  canSendNow: boolean;
  /** Why "Send feedback now" is not offered, in words for the hiring team. */
  blockedReason: string | null;
}

async function sessionEligibility(sessionId: string) {
  const s = await prisma.interviewSession.findUniqueOrThrow({
    where: { id: sessionId },
    select: {
      id: true, state: true, completedAt: true, tenantId: true, candidateId: true,
      candidate: { select: { email: true } }, feedbackOptIn: { select: { choice: true } },
    },
  });
  const eligibility = feedbackEligibility({
    state: s.state, completedAt: s.completedAt, partial: await wasScoredPartially(s.id),
    candidateEmail: s.candidate.email, optInChoice: s.feedbackOptIn?.choice ?? null, hasAssessment: true,
  });
  return { session: s, eligibility };
}

export async function feedbackEmailState(sessionId: string): Promise<FeedbackEmailView> {
  const [row, { eligibility }] = await Promise.all([
    prisma.candidateFeedbackEmail.findUnique({ where: { sessionId } }),
    sessionEligibility(sessionId),
  ]);
  const manual = manualSendAllowed(row);
  const blockedReason = !manual.allowed ? manual.reason : eligibility.eligible ? null : SKIP_REASON_TEXT[eligibility.reason];
  return {
    email: row
      ? {
        status: row.status, trigger: row.trigger, skipReason: row.skipReason,
        skipReasonText: row.skipReason ? SKIP_REASON_TEXT[row.skipReason as FeedbackSkipReason] ?? null : null,
        attempts: row.attempts, lastError: row.lastError, subject: row.subject, bodyText: row.bodyText,
        contentSource: row.contentSource, delivered: row.delivered, sentAt: row.sentAt,
        nextAttemptAt: row.nextAttemptAt, createdAt: row.createdAt,
      }
      : null,
    canSendNow: blockedReason === null,
    blockedReason,
  };
}

async function assertManualSendAllowed(sessionId: string) {
  const state = await feedbackEmailState(sessionId);
  if (!state.canSendNow) throw new HttpError(409, state.blockedReason ?? 'Feedback cannot be sent for this interview.');
}

/**
 * What "Send feedback now" would send, for the confirm dialog. The words are
 * stored with the row, so the send uses exactly what was previewed rather
 * than a fresh generation that could differ.
 */
export async function previewFeedbackEmail(opts: {
  sessionId: string;
  assessmentId: string;
}): Promise<{ to: string; subject: string; text: string }> {
  await assertManualSendAllowed(opts.sessionId);
  const session = await prisma.interviewSession.findUniqueOrThrow({
    where: { id: opts.sessionId },
    select: {
      tenantId: true, candidateId: true, candidate: { select: { fullName: true, email: true } },
      role: { select: { title: true } }, tenant: { select: { name: true } },
    },
  });
  const assessment = await prisma.assessmentVersion.findUniqueOrThrow({ where: { id: opts.assessmentId }, select: { id: true, resultJson: true } });
  let row = await prisma.candidateFeedbackEmail.findUnique({ where: { sessionId: opts.sessionId } });

  let content = row ? storedContent(row.contentJson) : null;
  if (!content) {
    let generated: { content: FeedbackContent; source: string };
    try {
      generated = await contentFor({ contentJson: '', contentSource: '', sessionId: opts.sessionId, assessment });
    } catch (err) {
      throw new HttpError(409, errorText(err));
    }
    content = generated.content;
    const fields = { contentJson: JSON.stringify(content), contentSource: generated.source };
    if (!row) {
      try {
        row = await prisma.candidateFeedbackEmail.create({
          data: {
            sessionId: opts.sessionId, assessmentId: assessment.id, candidateId: session.candidateId,
            tenantId: session.tenantId, trigger: 'manual', status: 'DRAFT', nextAttemptAt: null, ...fields,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw new HttpError(409, 'Someone else is sending this feedback right now. Refresh in a moment.');
      }
    } else if (manualSendAllowed(row).allowed) {
      // Only onto the row as it was read: if it moved on (sent, queued) in the
      // meantime, the preview is shown but nothing is overwritten.
      await prisma.candidateFeedbackEmail.updateMany({ where: { id: row.id, status: row.status, contentJson: row.contentJson }, data: fields });
    }
  }

  const rendered = renderAutoFeedbackEmail({
    to: session.candidate.email, candidateName: session.candidate.fullName, roleTitle: session.role.title,
    companyName: session.tenant.name, content,
    // Stands in for the link minted at send time; the preview text shows where it goes.
    talkUrl: `${config.webOrigin.replace(/\/+$/, '')}/talk-to-a-person/preview`,
  });
  return { to: session.candidate.email, subject: rendered.message.subject, text: rendered.storedText };
}

/**
 * "Send feedback now": for a completed interview whose feedback has not gone
 * (no row yet, a failure, a skip that no longer applies). Idempotent — once one
 * press has claimed the row, every other press is refused.
 */
export async function sendFeedbackNow(opts: {
  sessionId: string;
  assessmentId: string;
  userId: string;
  tenantId: string;
}): Promise<FeedbackEmailView> {
  await assertManualSendAllowed(opts.sessionId);
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: opts.sessionId }, select: { candidateId: true } });
  const now = new Date();
  const queued = {
    status: 'QUEUED', trigger: 'manual', requestedByUserId: opts.userId, nextAttemptAt: now,
    attempts: 0, skipReason: '', lastError: '', claimedAt: null,
  };
  const existing = await prisma.candidateFeedbackEmail.findUnique({ where: { sessionId: opts.sessionId } });
  let id: string;
  if (!existing) {
    try {
      const row = await prisma.candidateFeedbackEmail.create({
        data: { sessionId: opts.sessionId, assessmentId: opts.assessmentId, candidateId: session.candidateId, tenantId: opts.tenantId, ...queued },
      });
      id = row.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new HttpError(409, 'The feedback email is already on its way. Refresh in a moment.');
    }
  } else {
    // Judged again on the row as it is now, not on the state read by the
    // check above: a second press arriving while the first one's email is
    // QUEUED, SENDING or already SENT must not reset it to QUEUED and send
    // the candidate a second copy.
    const allowed = manualSendAllowed(existing);
    if (!allowed.allowed) throw new HttpError(409, allowed.reason);
    const { count } = await prisma.candidateFeedbackEmail.updateMany({
      where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt },
      data: queued,
    });
    if (count !== 1) throw new HttpError(409, 'The feedback email is already on its way. Refresh in a moment.');
    id = existing.id;
  }

  await logAudit({
    tenantId: opts.tenantId, actorType: 'user', actorId: opts.userId,
    action: 'feedback.email.requested', entityType: 'InterviewSession', entityId: opts.sessionId,
    after: { assessmentId: opts.assessmentId, previousStatus: existing?.status ?? null },
  });
  await attemptFeedbackEmail(id, now);
  return feedbackEmailState(opts.sessionId);
}
