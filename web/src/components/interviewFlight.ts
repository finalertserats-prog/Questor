/**
 * Where an interview stands from the operator's side: finished, waiting on the
 * candidate, or part-way through. Kept free of React so the lists, the phone
 * cards and their tests share one reading (see web/tests/interviewInFlight.test.ts).
 */

/**
 * States an interview will not leave on its own.
 *
 * Everything else is mid-flight: the candidate is part-way through, or waiting
 * on an invitation they have not acted on. That distinction is the whole point
 * of the marker below — a recruiter scanning this list needs to spot the person
 * who abandoned an interview two weeks ago without opening every row to find
 * out. Kept as a deny-list of endings rather than an allow-list of in-progress
 * states so a newly added intermediate state is treated as "still running"
 * (visible, chased) rather than silently reading as finished.
 */
const TERMINAL_STATES = new Set([
  // Not ACCEPTED: the candidate opened the link and has not started, which is
  // exactly the interview someone still chases or cancels.
  'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED',
  'CANCELLED', 'NO_SHOW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'CANDIDATE_WITHDREW',
  // Started, then stopped responding. Terminal so it leaves the chase list —
  // it was showing as "in progress" for hours after the tab was closed.
  'INCOMPLETE',
]);

/**
 * States where the candidate has been invited but has not yet begun. Nothing is
 * happening and nothing is stuck — someone simply has not turned up yet.
 */
const NOT_STARTED_STATES = new Set(['PROVISIONED', 'INVITED', 'ACCEPTED']);

export function isInFlight(state: string | null | undefined): boolean {
  return !!state && !TERMINAL_STATES.has(state);
}

/** Invited, not yet started. */
export function isAwaitingCandidate(state: string | null | undefined): boolean {
  return !!state && NOT_STARTED_STATES.has(state);
}

/** Actually part-way through an interview. */
export function isUnderway(state: string | null | undefined): boolean {
  return isInFlight(state) && !isAwaitingCandidate(state);
}
