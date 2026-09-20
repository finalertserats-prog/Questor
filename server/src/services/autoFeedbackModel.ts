/**
 * The rules behind the candidate's automatic feedback email, kept free of the
 * database so each one is tested on its own (tests/autoFeedbackModel.test.ts).
 * services/autoFeedback.ts applies them.
 */

export type AutoFeedbackStatus = 'DRAFT' | 'QUEUED' | 'SENDING' | 'SENT' | 'SENT_UNVERIFIED' | 'FAILED' | 'SKIPPED';

/**
 * The mail provider accepted the message (or never answered) but the row's
 * claim had already been taken, so we cannot say for certain what the
 * candidate received. Treated as "probably sent": never resent without
 * someone accepting the risk of a duplicate.
 */
export const SENT_UNVERIFIED_REASON = 'This feedback email may already have reached the candidate: the send was interrupted '
  + 'before it could be confirmed. Check with them before sending it again.';

export type FeedbackSkipReason =
  | 'POLICY_OFF'
  | 'NOT_COMPLETED'
  | 'PARTIAL_INTERVIEW'
  | 'WITHDRAWN'
  | 'DECLINED'
  | 'NO_EMAIL'
  | 'DEMO_RECIPIENT'
  | 'NO_ASSESSMENT';

/** Shown to the hiring team beside a skipped email, as-is. */
export const SKIP_REASON_TEXT: Readonly<Record<FeedbackSkipReason, string>> = {
  POLICY_OFF: 'Automatic feedback emails are switched off for your organisation.',
  NOT_COMPLETED: 'The interview was not completed, so no feedback was sent.',
  PARTIAL_INTERVIEW: 'Only part of the interview took place, so no feedback was sent.',
  WITHDRAWN: 'The candidate withdrew from the interview, so no feedback was sent.',
  DECLINED: 'The candidate said they did not want written feedback.',
  NO_EMAIL: 'The candidate has no email address on file.',
  DEMO_RECIPIENT: 'In the demo, email goes only to you, so nothing was sent to the candidate address.',
  NO_ASSESSMENT: 'There is no assessment for this interview to write feedback from.',
};

/**
 * On unless an admin switched it off. The owner wants every organisation to
 * send feedback, so only an explicit `false` stops it: a policy written before
 * the switch existed says nothing, and a malformed value is not a decision.
 */
export function autoCandidateFeedbackEnabled(policy: Readonly<Record<string, unknown>>): boolean {
  return policy.autoCandidateFeedback !== false;
}

/**
 * How long the hiring team has to review an interview before the candidate's
 * feedback goes out on its own.
 *
 * The owner's decision: a completed review sends it immediately, and a review
 * that never comes must not leave the candidate waiting. Twelve hours gives
 * the team a working day's grace either side of an interview.
 */
export const DEFAULT_REVIEW_WINDOW_HOURS = 12;

/** A week is the longest wait anyone could defend putting a candidate through. */
const MAX_REVIEW_WINDOW_HOURS = 168;

export function reviewWindowHours(policy: Readonly<Record<string, unknown>>, fallbackHours: number): number {
  const chosen = policy.feedbackReviewWindowHours;
  if (typeof chosen !== 'number' || !Number.isFinite(chosen)) return fallbackHours;
  if (chosen < 0 || chosen > MAX_REVIEW_WINDOW_HOURS) return fallbackHours;
  return chosen;
}

/** When the email becomes due if no review has been completed by then. */
export function feedbackDueAt(assessmentStoredAt: Date, hours: number): Date {
  return new Date(assessmentStoredAt.getTime() + hours * 60 * 60_000);
}

/** Why an email left the waiting room: the window ran out, a review landed, or a person sent it. */
export type FeedbackRelease = 'window' | 'review' | 'manual';

export const RELEASE_TEXT: Readonly<Record<FeedbackRelease, string>> = {
  window: 'Sent automatically once the review window passed.',
  review: 'Sent as soon as a reviewer completed their review.',
  manual: 'Sent from this page by a member of the hiring team.',
};

/**
 * Who signs the candidate's letter. Questor by default — it is Questor's
 * promise about how the feedback was written — with the organisation able to
 * put its own hiring team's name to it instead.
 */
export function feedbackSignOff(policy: Readonly<Record<string, unknown>>): 'questor' | 'company' {
  return policy.feedbackSignedByCompany === true ? 'company' : 'questor';
}

/**
 * Off unless an admin switched it on. Hiring teams see the assessment straight
 * away; an organisation that wants every reviewer to judge blind first opts in.
 */
export function blindReviewRequired(policy: Readonly<Record<string, unknown>>): boolean {
  return policy.requireBlindReview === true;
}

/** Where a completed interview can be. Anything else stopped short of the end. */
const COMPLETED_STATES: ReadonlySet<string> = new Set(['REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED']);

export interface EligibilityInput {
  readonly state: string;
  readonly completedAt: Date | null;
  /** A reviewer chose to score an interview that stopped part-way. */
  readonly partial: boolean;
  readonly candidateEmail: string;
  /** The candidate's own answer about written feedback, when they gave one. */
  readonly optInChoice: string | null;
  readonly hasAssessment: boolean;
}

export type Eligibility = { eligible: true } | { eligible: false; reason: FeedbackSkipReason };

/**
 * Whether this interview's candidate should be emailed feedback.
 *
 * A recorded "no" is honoured even though sending is otherwise automatic: the
 * candidate told us, and that answer is final (services/candidateFeedback.ts).
 * No answer is not a no — the owner's decision is that feedback goes to
 * everyone who finishes an interview.
 */
export function feedbackEligibility(i: EligibilityInput): Eligibility {
  if (i.state === 'CANDIDATE_WITHDREW') return { eligible: false, reason: 'WITHDRAWN' };
  // CLOSED is also where abandoned interviews end up; completedAt is what
  // tells a finished interview from one closed without finishing.
  if (!COMPLETED_STATES.has(i.state) || !i.completedAt) return { eligible: false, reason: 'NOT_COMPLETED' };
  if (i.partial) return { eligible: false, reason: 'PARTIAL_INTERVIEW' };
  if (!i.hasAssessment) return { eligible: false, reason: 'NO_ASSESSMENT' };
  if (i.optInChoice !== null && i.optInChoice !== 'YES') return { eligible: false, reason: 'DECLINED' };
  if (!i.candidateEmail.trim()) return { eligible: false, reason: 'NO_EMAIL' };
  return { eligible: true };
}

/** Attempts before a failing email is left for a person to look at. */
export const MAX_SEND_ATTEMPTS = 5;

const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;

/** One minute after the first failure, doubling, never more than an hour. */
export function retryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  return Math.min(BASE_RETRY_MS * 2 ** exponent, MAX_RETRY_MS);
}

export function afterFailedAttempt(
  attempts: number,
  now: Date,
): { status: 'QUEUED'; nextAttemptAt: Date } | { status: 'FAILED'; nextAttemptAt: null } {
  if (attempts >= MAX_SEND_ATTEMPTS) return { status: 'FAILED', nextAttemptAt: null };
  return { status: 'QUEUED', nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)) };
}

/**
 * Skips a person may override with "Send feedback now": the reason may no
 * longer hold (an email address added, the switch turned back on). A withdrawal,
 * a "no" or an unfinished interview is not something to override.
 */
const OVERRIDABLE_SKIPS: ReadonlySet<string> = new Set<FeedbackSkipReason>(['POLICY_OFF', 'NO_EMAIL', 'DEMO_RECIPIENT', 'NO_ASSESSMENT']);

export function manualSendAllowed(
  row: { readonly status: string; readonly skipReason: string; readonly nextAttemptAt?: Date | null } | null,
  opts: { readonly confirmDuplicate?: boolean; readonly now?: Date } = {},
): { allowed: true } | { allowed: false; reason: string; requiresConfirmation?: boolean } {
  if (!row || row.status === 'FAILED' || row.status === 'DRAFT') return { allowed: true };
  // A letter waiting out the review window is exactly what this button is for:
  // the reviewer has seen enough and wants the candidate told now.
  const waiting = row.status === 'QUEUED' && row.nextAttemptAt !== null && row.nextAttemptAt !== undefined
    && row.nextAttemptAt.getTime() > (opts.now ?? new Date()).getTime();
  if (waiting) return { allowed: true };
  // Only this one state can be overridden, and only deliberately: the risk is
  // a second copy of their feedback, not a lost email.
  if (row.status === 'SENT_UNVERIFIED') {
    return opts.confirmDuplicate === true
      ? { allowed: true }
      : { allowed: false, reason: SENT_UNVERIFIED_REASON, requiresConfirmation: true };
  }
  if (row.status === 'SENT') return { allowed: false, reason: 'Feedback has already been sent to this candidate.' };
  if (row.status === 'QUEUED' || row.status === 'SENDING') {
    return { allowed: false, reason: 'The feedback email is already on its way. Refresh in a moment.' };
  }
  if (row.status === 'SKIPPED' && OVERRIDABLE_SKIPS.has(row.skipReason)) return { allowed: true };
  const text = SKIP_REASON_TEXT[row.skipReason as FeedbackSkipReason];
  return { allowed: false, reason: text ?? 'Feedback cannot be sent for this interview.' };
}
