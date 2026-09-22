import type { Prisma } from '@prisma/client';
import { CorruptRecordError, parseJson, parseJsonStrict, prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import type { AssessmentResult } from '../domain/types.js';
import { getEmail, type EmailMessage, type EmailProvider } from '../providers/email/index.js';
import { EMAIL_SEND_TIMEOUT_MS, EmailSendTimeoutError } from '../providers/email/timing.js';
import { renderAutoFeedbackEmail } from '../providers/email/autoFeedbackEmail.js';
import { logAudit } from './audit.js';
import { issueHumanRequestToken } from './candidateFeedback.js';
import {
  autoCandidateFeedbackEnabledForTenant, feedbackReviewWindowHoursForTenant, feedbackSignOffForTenant,
} from './candidateFeedbackPolicy.js';
import { applyReviewOverrides, type CompletedReview } from '../domain/reviewedAssessment.js';
import { completedReviewFor, scorecardProfileFor } from './assessmentReview.js';
import { demoRecipientBlocked } from './demoPolicy.js';
import { startJob } from './jobs.js';
import { generateFeedbackContent } from './autoFeedbackContent.js';
import { feedbackContentSchema, type FeedbackContent, type FeedbackInput } from './feedbackContentModel.js';
import {
  RELEASE_TEXT, SENT_UNVERIFIED_REASON, SKIP_REASON_TEXT, afterFailedAttempt, feedbackDueAt,
  feedbackEligibility, manualSendAllowed, type FeedbackRelease, type FeedbackSkipReason,
} from './autoFeedbackModel.js';

/**
 * The candidate's feedback email: prepared when their interview is assessed,
 * sent when the hiring team has had their say — or when the wait runs out.
 *
 * WHEN IT GOES (the owner's rule)
 *   - A completed human review sends it at once, written from the reviewed
 *     assessment, so a reviewer's corrections are what the candidate reads.
 *   - Otherwise the review window (12 hours by default, see
 *     autoFeedbackModel.ts) runs out and it goes written from the AI's own
 *     reading. Nobody is left waiting on a review that never comes.
 *   - "Send feedback now" ignores the window entirely.
 *   - A review completed AFTER it went does not send a second one; the team
 *     can write to the candidate themselves.
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
 *   - An in-flight send renews its claim (a heartbeat) and is bounded by
 *     FEEDBACK_SEND_TIMEOUT_MS, so a slow provider is never mistaken for a
 *     dead process. A claim that really does go stale is marked FAILED, NOT
 *     retried: the email may already have gone, and a candidate receiving
 *     their feedback twice is worse than a person checking.
 *   - If the provider accepted the message but the claim had been taken
 *     anyway, the row says SENT_UNVERIFIED rather than FAILED, and "Send
 *     feedback now" refuses it until someone accepts the risk of a duplicate.
 *   - SENDING AND REVIEWING EXCLUDE EACH OTHER. A send takes a lock on the row
 *     (sendLockUntil) before it composes a word, and completing a review is
 *     refused for as long as that lock is held (gateReviewCompletion). An
 *     email cannot be unsent, so the review is what waits — never more than
 *     the provider timeout plus a little slack, after which a dead worker's
 *     lock is simply expired. Conditional updateMany is row-atomic on
 *     Postgres as well as SQLite, so no SELECT FOR UPDATE is needed.
 *
 * Every skip rule is checked again at send time, not just at queue time: a
 * candidate can withdraw, say no, or lose their address in between.
 */

export const FEEDBACK_EMAIL_JOB = { name: 'candidate-feedback-email', intervalMs: 15_000, ttlMs: 5 * 60_000, batch: 20 } as const;

/** A claim older than this, and not renewed, belongs to a send that died. */
export const FEEDBACK_SEND_STALE_MS = 10 * 60_000;

/**
 * How long one send may hold the provider. Far inside the stale window on
 * purpose: a provider that hangs for longer than that would otherwise still
 * be sending while another instance declared the claim abandoned.
 */
export const FEEDBACK_SEND_TIMEOUT_MS = EMAIL_SEND_TIMEOUT_MS;

/** How often an in-flight send renews its claim, so a slow send is not swept. */
export const FEEDBACK_SEND_HEARTBEAT_MS = 60_000;

/**
 * Slack past the provider timeout before a send lock counts as gone. A minute,
 * because the send itself is ended by force at the timeout — SendGrid's fetch
 * is aborted, and the child process holding an SMTP socket is killed
 * (providers/email/smtpSend.ts) — and this grace puts the lock's expiry
 * strictly after that, so no socket to a mail server can still be open when a
 * review is admitted. tests/emailSmtpTimeouts.test.ts holds the two to it.
 */
export const SEND_LOCK_GRACE_MS = 60_000;

/** The refusal a reviewer gets while the candidate's letter is being sent. */
export const FEEDBACK_SENDING = 'feedback_sending';
export const FEEDBACK_SENDING_MESSAGE = "The candidate's feedback email is being sent right now. Please submit your review again in a minute.";

let sendTimeoutMs: number = FEEDBACK_SEND_TIMEOUT_MS;

/** Test hook: shorten (or restore, with null) the provider timeout. */
export function _setFeedbackSendTimeoutForTest(ms: number | null): void {
  sendTimeoutMs = ms ?? FEEDBACK_SEND_TIMEOUT_MS;
}

/**
 * The provider did not answer in time. Distinct from a refusal, because it
 * means something different: a refusal is an outcome, a timeout is not one.
 */
class SendTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`The mail provider did not answer within ${seconds}s.`);
  }
}

/**
 * Send, but never wait for ever — and stop the request, which every provider
 * can now do: SendGrid aborts its fetch, and SMTP kills the child process that
 * holds the socket (providers/email/smtpSend.ts).
 *
 * A timeout is still NOT a failure to retry. Killing the send makes acceptance
 * after the deadline impossible, but it cannot rule out an acceptance that had
 * already happened — inside the lock — and whose confirmation never arrived.
 * So the caller records the outcome as unknown and leaves the lock to expire.
 *
 * The provider's own deadline is the same number and may fire first; it means
 * exactly the same thing, so it is reported the same way.
 */
async function sendWithinTimeout(email: EmailProvider, message: EmailMessage): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SendTimeoutError(Math.round(sendTimeoutMs / 1000)));
    }, sendTimeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([email.send(message, { signal: controller.signal }), expiry]);
  } catch (err) {
    if (err instanceof EmailSendTimeoutError) throw new SendTimeoutError(Math.round(err.ms / 1000));
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Recorded by POST /interviews/:id/assess-partial; a partial interview is never emailed. */
const ASSESS_PARTIAL_ACTION = 'interview.assess_partial';
const MAX_ERROR_CHARS = 500;
const INTERRUPTED_NOTE = 'The send was interrupted and may or may not have reached the candidate. '
  + 'Check with them before sending again.';
const REVIEW_MISSED_NOTE = 'A review was completed while this email was being sent, so the candidate received the version '
  + 'written before it. Write to them yourself if the review changed the picture.';

/** What the words were written from: the review they follow, or the AI's own reading. */
function basisOf(review: CompletedReview | null): string {
  return review ? `review:${review.id}` : 'ai';
}

type Outcome = 'not-due' | 'sent' | 'sent-unverified' | 'skipped' | 'retry' | 'failed';

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
 * Prepare the email for an interview whose assessment was just stored.
 *
 * It does NOT go out yet. The owner's rule: the hiring team gets a window —
 * twelve hours by default — to complete their review, and the candidate hears
 * from us the moment that review lands. If no review comes, the window runs
 * out and the letter goes anyway, written from the AI's own reading. Either
 * way the words are composed at send time, so a reviewer's corrections are in
 * the letter the candidate actually receives.
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

  const windowHours = await feedbackReviewWindowHoursForTenant(session.tenantId);
  // A reviewer can be quicker than the finalisation's own bookkeeping. A
  // review already on file means the wait is over before it began.
  const alreadyReviewed = !skip && (await completedReviewFor(opts.assessmentId)) !== null;
  let id: string;
  try {
    const row = await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: opts.sessionId, assessmentId: opts.assessmentId,
        candidateId: session.candidateId, tenantId: session.tenantId, trigger: 'auto',
        status: skip ? 'SKIPPED' : 'QUEUED', skipReason: skip ?? '',
        nextAttemptAt: skip ? null : alreadyReviewed ? now : feedbackDueAt(now, windowHours),
        releaseReason: alreadyReviewed ? 'review' : '',
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

/**
 * A reviewer has finished with this assessment: the candidate hears now rather
 * than when the window runs out.
 *
 * Only a letter still waiting is released. One that has already gone is left
 * exactly as it is — a review landing afterwards does not send a second copy
 * of anything, and the hiring team can write to the candidate themselves if
 * the review changed the picture.
 */
export async function gateReviewCompletion(tx: Prisma.TransactionClient, assessmentId: string, now = new Date()): Promise<boolean> {
  const row = await tx.candidateFeedbackEmail.findFirst({ where: { assessmentId }, select: { id: true, status: true, sendLockUntil: true } });
  // A send that timed out is over for us but not necessarily for the
  // provider: its lock stands until sendLockUntil, and so does the refusal.
  if (row?.status === 'SENT_UNVERIFIED') {
    if (row.sendLockUntil !== null && row.sendLockUntil.getTime() >= now.getTime()) throw new HttpError(409, FEEDBACK_SENDING_MESSAGE, FEEDBACK_SENDING);
    return false;
  }
  // Already sent, skipped, failed or never queued: a review changes nothing
  // about the letter, so nothing stands in its way.
  if (!row || (row.status !== 'QUEUED' && row.status !== 'SENDING')) return false;

  // The gate itself: one conditional write. It succeeds only while no send
  // holds the lock, and it is the same row a send must lock before composing,
  // so exactly one of the two gets through.
  const { count } = await tx.candidateFeedbackEmail.updateMany({
    where: { id: row.id, status: row.status, OR: [{ sendLockUntil: null }, { sendLockUntil: { lt: now } }] },
    data: { releaseReason: 'review', ...(row.status === 'QUEUED' ? { nextAttemptAt: now } : {}) },
  });
  if (count === 1) return true;

  // Refused, or the row moved on between the read and the write. Look once
  // more: a live lock means the review waits; anything else means it goes.
  const fresh = await tx.candidateFeedbackEmail.findUnique({ where: { id: row.id }, select: { status: true, sendLockUntil: true } });
  const locked = fresh !== null
    && (fresh.status === 'QUEUED' || fresh.status === 'SENDING')
    && fresh.sendLockUntil !== null
    && fresh.sendLockUntil.getTime() >= now.getTime();
  if (locked) throw new HttpError(409, FEEDBACK_SENDING_MESSAGE, FEEDBACK_SENDING);
  return false;
}

/**
 * Letters queued before the review window existed were due the moment they
 * were written. Left alone, every one of them would fire on the first tick
 * after the deploy that introduced the window, straight past it. Run once at
 * start-up; a row moved once no longer matches, so running it again is free.
 */
export async function rescheduleLegacyFeedbackEmails(now = new Date()): Promise<number> {
  const rows = await prisma.candidateFeedbackEmail.findMany({
    where: { status: 'QUEUED', trigger: 'auto', releaseReason: '' },
    select: { id: true, tenantId: true, createdAt: true, nextAttemptAt: true },
  });
  let moved = 0;
  for (const row of rows) {
    // Due within a minute of being written is the old behaviour; anything
    // later was queued with a window and is left where it is.
    if (!row.nextAttemptAt || row.nextAttemptAt.getTime() > row.createdAt.getTime() + 60_000) continue;
    const windowHours = await feedbackReviewWindowHoursForTenant(row.tenantId);
    if (windowHours <= 0) continue;
    const { count } = await prisma.candidateFeedbackEmail.updateMany({
      where: { id: row.id, status: 'QUEUED', releaseReason: '', nextAttemptAt: row.nextAttemptAt },
      data: { nextAttemptAt: feedbackDueAt(row.createdAt, windowHours) },
    });
    moved += count;
  }
  if (moved > 0) logger.info({ moved, at: now.toISOString() }, 'Rescheduled feedback emails queued before the review window existed');
  return moved;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * The live claim on a row. `at` moves as the heartbeat renews it, and every
 * conditional write this attempt makes is keyed on the current value — so a
 * claim that was taken from us elsewhere can never be written over.
 */
interface Claim {
  at: Date;
  /** The send lock this attempt holds, so only its own lock is ever cleared. */
  lockUntil: Date | null;
  /**
   * True once the provider has been called and not answered: the lock then
   * has to outlive the attempt, because the call it guards may still deliver.
   */
  outcomeUnknown: boolean;
}

/**
 * Take the send lock, or find that a review has the row. Keyed on this
 * attempt's own claim, so a claim that was lost cannot lock a row that has
 * since been re-claimed by another worker.
 */
async function takeSendLock(id: string, claim: Claim, now: Date): Promise<boolean> {
  const lockUntil = new Date(now.getTime() + sendTimeoutMs + SEND_LOCK_GRACE_MS);
  const { count } = await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'SENDING', claimedAt: claim.at, OR: [{ sendLockUntil: null }, { sendLockUntil: { lt: now } }] },
    data: { sendLockUntil: lockUntil },
  });
  if (count === 1) claim.lockUntil = lockUntil;
  return count === 1;
}

/**
 * Let the lock go once the attempt has a definite outcome — sent, or refused
 * by the provider before the timeout. Only the exact lock this attempt set.
 * After a timeout the lock stays, to expire on its own at sendLockUntil.
 */
async function releaseSendLock(id: string, claim: Claim): Promise<void> {
  if (!claim.lockUntil || claim.outcomeUnknown) return;
  await prisma.candidateFeedbackEmail.updateMany({ where: { id, sendLockUntil: claim.lockUntil }, data: { sendLockUntil: null } })
    .catch((err: unknown) => logger.error({ feedbackEmailId: id, err: errorText(err) }, 'Could not release the feedback send lock; it will expire'));
  claim.lockUntil = null;
}

/**
 * Keep saying "still working" while a send is in flight, so a slow provider
 * is not mistaken for a dead process by the stale-claim sweep.
 */
function startClaimHeartbeat(id: string, claim: Claim): () => void {
  const timer = setInterval(() => {
    const next = new Date();
    prisma.candidateFeedbackEmail
      .updateMany({ where: { id, status: 'SENDING', claimedAt: claim.at }, data: { claimedAt: next } })
      .then(({ count }) => { if (count === 1) claim.at = next; })
      .catch((err: unknown) => logger.warn({ feedbackEmailId: id, err: errorText(err) }, 'Could not renew the feedback email claim'));
  }, FEEDBACK_SEND_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * One attempt at one email. Does nothing unless it wins the claim, so it is
 * safe to call from anywhere, any number of times at once.
 */
export async function attemptFeedbackEmail(id: string, now = new Date()): Promise<Outcome> {
  const claim: Claim = { at: now, lockUntil: null, outcomeUnknown: false };
  const claimed = await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'QUEUED', nextAttemptAt: { lte: now } },
    data: { status: 'SENDING', claimedAt: claim.at },
  });
  if (claimed.count !== 1) return 'not-due';
  const stopHeartbeat = startClaimHeartbeat(id, claim);
  try {
    return await sendClaimed(id, claim);
  } catch (err) {
    // Stopped before the outcome is written, so no further tick can move
    // claimedAt out from under the write.
    stopHeartbeat();
    if (err instanceof SendTimeoutError) return await recordTimedOutSend(id, claim, err);
    return await recordFailure(id, claim, err);
  } finally {
    stopHeartbeat();
    await releaseSendLock(id, claim);
  }
}

async function loadClaimed(id: string) {
  return prisma.candidateFeedbackEmail.findUniqueOrThrow({
    where: { id },
    include: {
      assessment: { select: { id: true, resultJson: true, scorecardId: true } },
      session: {
        select: {
          id: true, state: true, completedAt: true, tenantId: true, candidateId: true, durationMinutes: true,
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
  contentJson: string; contentSource: string; contentBasis: string; sessionId: string;
  assessment: { id: string; resultJson: string; scorecardId: string };
}, review: CompletedReview | null): Promise<{ content: FeedbackContent; source: string; basis: string }> {
  // What the words were written from. A review landing after they were
  // prepared changes this, and the letter is written again — the candidate
  // must never receive an account a human had already corrected.
  const basis = basisOf(review);
  const stored = storedContent(row.contentJson);
  if (stored && row.contentBasis === basis) return { content: stored, source: row.contentSource, basis };

  let aiResult: AssessmentResult;
  try {
    aiResult = parseJsonStrict<AssessmentResult>(row.assessment.resultJson, { model: 'AssessmentVersion', id: row.assessment.id, field: 'resultJson' });
  } catch (err) {
    if (err instanceof CorruptRecordError) throw new Error('The assessment record could not be read, so no feedback was written.');
    throw err;
  }
  const input: FeedbackInput = {
    // The reviewer's levels where they recorded any: their reading of the
    // interview is the one the candidate should hear about.
    result: applyReviewOverrides(aiResult, review),
    profile: await scorecardProfileFor(row.assessment.scorecardId),
  };
  const generated = await generateFeedbackContent(input, row.sessionId);
  return { content: generated.content, source: generated.source, basis };
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

async function sendClaimed(id: string, claim: Claim): Promise<Outcome> {
  const row = await loadClaimed(id);
  const skip = await skipReasonAtSend(row);
  if (skip) {
    await prisma.candidateFeedbackEmail.updateMany({
      where: { id, status: 'SENDING', claimedAt: claim.at },
      data: { status: 'SKIPPED', skipReason: skip, claimedAt: null, nextAttemptAt: null },
    });
    await logAudit({
      tenantId: row.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
      action: 'feedback.email.skipped', entityType: 'InterviewSession', entityId: row.sessionId, after: { reason: skip },
    });
    return 'skipped';
  }

  const s = row.session;
  // The lock, before a word is composed. From here until the provider answers
  // no review can be completed, so what is read next is what the candidate
  // gets. One retry: a lock refused on our own claim means a previous run of
  // ours died within the grace period and its lock has just expired.
  if (!await takeSendLock(id, claim, new Date()) && !await takeSendLock(id, claim, new Date())) {
    throw new Error('Another send still holds this letter; it will be tried again.');
  }
  let { content, source, basis } = await contentFor(row, await completedReviewFor(row.assessmentId));
  // Composing takes a model call. A review that landed between the claim and
  // the lock is on file now, and the words are checked against it once more
  // before anything leaves — nothing can land after the lock.
  const latest = await completedReviewFor(row.assessmentId);
  if (basisOf(latest) !== basis) ({ content, source, basis } = await contentFor(row, latest));
  const rendered = renderAutoFeedbackEmail({
    to: s.candidate.email, candidateName: s.candidate.fullName, roleTitle: s.role.title,
    companyName: s.tenant.name, content, talkUrl: await talkLink(s),
    interviewedAt: s.completedAt, durationMinutes: s.durationMinutes,
    signOff: await feedbackSignOffForTenant(s.tenantId),
  });
  // Stored before the send: if the process dies after the mail went, the row
  // still says what went (and the stale-claim sweep marks it for a person).
  await prisma.candidateFeedbackEmail.update({
    where: { id },
    data: {
      contentJson: JSON.stringify(content), contentSource: source, contentBasis: basis,
      subject: rendered.message.subject, bodyText: rendered.storedText,
    },
  });
  // A release reason is only missing when the window itself ran out. Written
  // conditionally, so a review that marked this row while it was in flight
  // is not overwritten.
  await prisma.candidateFeedbackEmail.updateMany({ where: { id, releaseReason: '' }, data: { releaseReason: 'window' } });

  const email = getEmail();
  // Bounded well inside the stale window, so a provider that never answers
  // cannot still be sending while another instance decides this claim is dead.
  await sendWithinTimeout(email, rendered.message);

  const sentAt = new Date();
  // Defensive only: the lock makes a review during the send impossible, so
  // this is never expected to be true. If it ever is, the lock is broken and
  // the fact must not pass quietly.
  const afterSend = await completedReviewFor(row.assessmentId);
  const reviewMissed = basisOf(afterSend) !== basis;
  const confirmed = await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'SENDING', claimedAt: claim.at },
    data: {
      status: 'SENT', sentAt, delivered: email.delivers, attempts: row.attempts + 1,
      lastError: '', claimedAt: null, nextAttemptAt: null, sendLockUntil: null,
    },
  });
  claim.lockUntil = null;
  // The claim was taken from us while the provider had the message: the email
  // went, but the row now says something else (the sweep marks an abandoned
  // claim FAILED). Leaving it there would invite a person to send a second
  // copy, so the row says "probably sent, unconfirmed" and names the doubt.
  if (confirmed.count !== 1) return recordUnverifiedSend(id, row, { sentAt, delivered: email.delivers });

  if (reviewMissed) {
    await prisma.candidateFeedbackEmail.updateMany({ where: { id, status: 'SENT' }, data: { lastError: REVIEW_MISSED_NOTE } });
    logger.error({ feedbackEmailId: id, sessionId: row.sessionId }, 'A review was completed during a locked send; the send lock did not hold');
    await logAudit({
      tenantId: row.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
      action: 'feedback.email.sent_before_review', entityType: 'InterviewSession', entityId: row.sessionId,
      after: { assessmentId: row.assessmentId, sentFrom: basis, reviewId: afterSend?.id ?? null },
    });
  }

  await logAudit({
    tenantId: row.tenantId,
    actorType: row.trigger === 'manual' && row.requestedByUserId ? 'user' : 'system',
    actorId: row.trigger === 'manual' && row.requestedByUserId ? row.requestedByUserId : 'candidate-feedback-email',
    action: 'feedback.email.sent', entityType: 'InterviewSession', entityId: row.sessionId,
    after: { assessmentId: row.assessmentId, trigger: row.trigger, contentSource: source, contentBasis: basis, delivered: email.delivers, sentAt },
  });
  return 'sent';
}

/**
 * A send that reached the provider but could not claim its own row back.
 *
 * Written only over a row nobody else is actively sending: if another attempt
 * has since claimed it, that attempt owns the outcome and this one only says
 * so in the log.
 */
async function recordUnverifiedSend(
  id: string,
  row: { attempts: number; tenantId: string; sessionId: string; assessmentId: string },
  outcome: { sentAt: Date; delivered: boolean },
): Promise<Outcome> {
  const { count } = await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: { in: ['QUEUED', 'FAILED', 'SKIPPED', 'DRAFT', 'SENT_UNVERIFIED'] } },
    data: {
      status: 'SENT_UNVERIFIED', sentAt: outcome.sentAt, delivered: outcome.delivered,
      attempts: row.attempts + 1, lastError: SENT_UNVERIFIED_REASON, claimedAt: null, nextAttemptAt: null, sendLockUntil: null,
    },
  });
  logger.error(
    { feedbackEmailId: id, sessionId: row.sessionId, recorded: count === 1 },
    'Candidate feedback email was sent but its claim had been released; recorded as unconfirmed',
  );
  await logAudit({
    tenantId: row.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
    action: 'feedback.email.sent_unverified', entityType: 'InterviewSession', entityId: row.sessionId,
    after: { assessmentId: row.assessmentId, sentAt: outcome.sentAt, delivered: outcome.delivered, recorded: count === 1 },
  });
  return 'sent-unverified';
}

/**
 * The provider did not answer. The message may or may not have gone, and a
 * provider that cannot be aborted may still deliver it, so this is neither a
 * send nor a failure: it is recorded as an unconfirmed send — the same state
 * as a claim lost mid-flight — with the lock left standing until it expires.
 * Never retried on its own; a person decides, and only once the lock is gone.
 */
async function recordTimedOutSend(id: string, claim: Claim, err: SendTimeoutError): Promise<Outcome> {
  claim.outcomeUnknown = true;
  const row = await prisma.candidateFeedbackEmail.findUnique({ where: { id }, select: { attempts: true, tenantId: true, sessionId: true, assessmentId: true } });
  if (!row) return 'sent-unverified';
  const sentAt = new Date();
  const note = `The mail provider did not answer within ${err.seconds}s; the message may still have been delivered. `
    + 'Check with the candidate before sending again.';
  // Keyed on the status alone, not on the claim: a heartbeat tick already in
  // flight when the heartbeat was stopped may still land and move claimedAt,
  // and a write keyed on it would then match nothing, leaving the row SENDING
  // for ever. The lock, which only this attempt holds, is what protects the row.
  const { count } = await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'SENDING' },
    data: {
      status: 'SENT_UNVERIFIED', sentAt, delivered: getEmail().delivers, attempts: row.attempts + 1,
      lastError: note, claimedAt: null, nextAttemptAt: null,
    },
  });
  if (count !== 1) {
    // The row is not where this attempt left it. Whatever moved it owns it
    // now; this attempt says so where it will be seen, rather than silently
    // leaving a send nobody can account for.
    const fresh = await prisma.candidateFeedbackEmail.findUnique({ where: { id }, select: { status: true, claimedAt: true, sendLockUntil: true } });
    logger.error(
      { feedbackEmailId: id, sessionId: row.sessionId, status: fresh?.status ?? null, claimedAt: fresh?.claimedAt ?? null },
      'Timed-out feedback send could not be recorded: the row had already moved on',
    );
    await logAudit({
      tenantId: row.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
      action: 'feedback.email.inconsistent', entityType: 'InterviewSession', entityId: row.sessionId,
      after: { assessmentId: row.assessmentId, expected: 'SENDING', found: fresh?.status ?? null, timeoutSeconds: err.seconds },
    });
    return 'sent-unverified';
  }
  logger.error({ feedbackEmailId: id, sessionId: row.sessionId, timeoutSeconds: err.seconds }, 'Candidate feedback email timed out; outcome unknown, send lock left to expire');
  await logAudit({
    tenantId: row.tenantId, actorType: 'system', actorId: 'candidate-feedback-email',
    action: 'feedback.email.timed_out', entityType: 'InterviewSession', entityId: row.sessionId,
    after: { assessmentId: row.assessmentId, timeoutSeconds: err.seconds, lockUntil: claim.lockUntil },
  });
  return 'sent-unverified';
}

async function recordFailure(id: string, claim: Claim, err: unknown): Promise<Outcome> {
  const message = errorText(err);
  const row = await prisma.candidateFeedbackEmail.findUnique({ where: { id }, select: { attempts: true, tenantId: true, sessionId: true } });
  if (!row) return 'failed';
  const attempts = row.attempts + 1;
  const next = afterFailedAttempt(attempts, new Date());
  await prisma.candidateFeedbackEmail.updateMany({
    where: { id, status: 'SENDING', claimedAt: claim.at },
    data: { status: next.status, nextAttemptAt: next.nextAttemptAt, attempts, lastError: message, claimedAt: null, sendLockUntil: null },
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
      data: { status: 'FAILED', lastError: INTERRUPTED_NOTE, claimedAt: null, nextAttemptAt: null, sendLockUntil: null },
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
  const tally: Record<Outcome, number> = { 'not-due': 0, sent: 0, 'sent-unverified': 0, skipped: 0, retry: 0, failed: 0 };
  for (const d of due) tally[await attemptFeedbackEmail(d.id, now)] += 1;
  return `${due.length} due: ${tally.sent} sent, ${tally['sent-unverified']} unconfirmed, ${tally.skipped} skipped, `
    + `${tally.retry} retrying, ${tally.failed} failed; ${interrupted} interrupted`;
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
    releaseReason: string;
    releaseText: string | null;
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
  /**
   * The one refusal a person may override: a send we could not confirm. The
   * page has to name the risk of a second copy before it offers the button.
   */
  needsDuplicateConfirmation: boolean;
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

export async function feedbackEmailState(
  sessionId: string,
  opts: { confirmDuplicate?: boolean } = {},
): Promise<FeedbackEmailView> {
  const [row, { eligibility }] = await Promise.all([
    prisma.candidateFeedbackEmail.findUnique({ where: { sessionId } }),
    sessionEligibility(sessionId),
  ]);
  const manual = manualSendAllowed(row, { ...opts, now: new Date() });
  const blockedReason = !manual.allowed ? manual.reason : eligibility.eligible ? null : SKIP_REASON_TEXT[eligibility.reason];
  return {
    email: row
      ? {
        status: row.status, trigger: row.trigger, skipReason: row.skipReason,
        skipReasonText: row.skipReason ? SKIP_REASON_TEXT[row.skipReason as FeedbackSkipReason] ?? null : null,
        releaseReason: row.releaseReason,
        releaseText: row.releaseReason ? RELEASE_TEXT[row.releaseReason as FeedbackRelease] ?? null : null,
        attempts: row.attempts, lastError: row.lastError, subject: row.subject, bodyText: row.bodyText,
        contentSource: row.contentSource, delivered: row.delivered, sentAt: row.sentAt,
        nextAttemptAt: row.nextAttemptAt, createdAt: row.createdAt,
      }
      : null,
    canSendNow: blockedReason === null,
    blockedReason,
    needsDuplicateConfirmation: !manual.allowed && manual.requiresConfirmation === true,
  };
}

async function assertManualSendAllowed(sessionId: string, opts: { confirmDuplicate?: boolean } = {}) {
  const state = await feedbackEmailState(sessionId, opts);
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
      tenantId: true, candidateId: true, completedAt: true, durationMinutes: true,
      candidate: { select: { fullName: true, email: true } },
      role: { select: { title: true } }, tenant: { select: { name: true } },
    },
  });
  const assessment = await prisma.assessmentVersion.findUniqueOrThrow({
    where: { id: opts.assessmentId }, select: { id: true, resultJson: true, scorecardId: true },
  });
  const review = await completedReviewFor(opts.assessmentId);
  let row = await prisma.candidateFeedbackEmail.findUnique({ where: { sessionId: opts.sessionId } });

  // The stored words are reused only when they were written from the same
  // state of the assessment; otherwise the preview shows what would actually
  // be sent now, review included.
  const basis = basisOf(review);
  let content = row && row.contentBasis === basis ? storedContent(row.contentJson) : null;
  if (!content) {
    let generated: { content: FeedbackContent; source: string; basis: string };
    try {
      generated = await contentFor({ contentJson: '', contentSource: '', contentBasis: '', sessionId: opts.sessionId, assessment }, review);
    } catch (err) {
      throw new HttpError(409, errorText(err));
    }
    content = generated.content;
    const fields = { contentJson: JSON.stringify(content), contentSource: generated.source, contentBasis: generated.basis };
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
    interviewedAt: session.completedAt, durationMinutes: session.durationMinutes,
    signOff: await feedbackSignOffForTenant(session.tenantId),
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
  /** Someone has read the warning that the candidate may already have this email. */
  confirmPossibleDuplicate?: boolean;
}): Promise<FeedbackEmailView> {
  const confirmDuplicate = opts.confirmPossibleDuplicate === true;
  await assertManualSendAllowed(opts.sessionId, { confirmDuplicate });
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: opts.sessionId }, select: { candidateId: true } });
  const now = new Date();
  const queued = {
    status: 'QUEUED', trigger: 'manual', requestedByUserId: opts.userId, nextAttemptAt: now,
    releaseReason: 'manual', attempts: 0, skipReason: '', lastError: '', claimedAt: null,
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
    const allowed = manualSendAllowed(existing, { confirmDuplicate, now: new Date() });
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
    after: { assessmentId: opts.assessmentId, previousStatus: existing?.status ?? null, confirmedPossibleDuplicate: confirmDuplicate },
  });
  await attemptFeedbackEmail(id, now);
  return feedbackEmailState(opts.sessionId);
}
