/**
 * The rules behind the candidate's automatic feedback email, kept free of the
 * database so each one is tested on its own (tests/autoFeedbackModel.test.ts).
 * services/autoFeedback.ts applies them.
 */

export type AutoFeedbackStatus = 'DRAFT' | 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

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
  row: { readonly status: string; readonly skipReason: string } | null,
): { allowed: true } | { allowed: false; reason: string } {
  if (!row || row.status === 'FAILED' || row.status === 'DRAFT') return { allowed: true };
  if (row.status === 'SENT') return { allowed: false, reason: 'Feedback has already been sent to this candidate.' };
  if (row.status === 'QUEUED' || row.status === 'SENDING') {
    return { allowed: false, reason: 'The feedback email is already on its way. Refresh in a moment.' };
  }
  if (row.status === 'SKIPPED' && OVERRIDABLE_SKIPS.has(row.skipReason)) return { allowed: true };
  const text = SKIP_REASON_TEXT[row.skipReason as FeedbackSkipReason];
  return { allowed: false, reason: text ?? 'Feedback cannot be sent for this interview.' };
}
