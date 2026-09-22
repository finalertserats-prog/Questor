/**
 * What a phone card says a person should do next, kept free of React so it can
 * be unit tested (see web/tests/listCardModel.test.ts).
 *
 * On a phone the table's last column — the action — was the one pushed off
 * screen. The card puts it on its own full-width line, worded as the next step
 * rather than a generic "Open".
 */

import { isAwaitingCandidate, isUnderway } from './interviewFlight';

/**
 * How a card is marked: a coloured rule down its leading edge, never a fill.
 * urgent = something stopped or went wrong; review = waiting on a person here;
 * waiting = waiting on the candidate; live = happening now.
 */
export type CardMark = 'urgent' | 'review' | 'waiting' | 'live';

export interface NextAction {
  readonly label: string;
  readonly to: string;
  readonly mark?: CardMark;
}

/** States that ended without a finished interview; someone should look. */
const STOPPED_STATES = new Set(['NO_SHOW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'CANDIDATE_WITHDREW', 'INCOMPLETE', 'MANUAL_HANDOFF', 'RESCHEDULE_REQUIRED']);

export interface CandidateCardSource {
  readonly id: string;
  readonly latestInterview: { readonly id: string; readonly state: string } | null;
}

export function candidateNextAction(c: CandidateCardSource): NextAction {
  const iv = c.latestInterview;
  if (!iv) return { label: 'Set up an interview', to: `/candidates/${c.id}?tab=journey` };
  if (iv.state === 'REVIEW_READY') return { label: 'Review the interview', to: `/interviews/${iv.id}`, mark: 'review' };
  if (STOPPED_STATES.has(iv.state)) return { label: 'See what happened', to: `/interviews/${iv.id}`, mark: 'urgent' };
  if (isAwaitingCandidate(iv.state)) return { label: 'Check the invitation', to: `/interviews/${iv.id}`, mark: 'waiting' };
  if (isUnderway(iv.state)) return { label: 'Open the live interview', to: `/interviews/${iv.id}`, mark: 'live' };
  return { label: 'Open candidate', to: `/candidates/${c.id}` };
}

export interface InterviewCardSource {
  readonly id: string;
  readonly state: string;
  readonly assessmentId: string | null;
  readonly blindReviewPending?: boolean;
}

export function interviewNextAction(s: InterviewCardSource): NextAction {
  if (s.assessmentId && s.blindReviewPending) return { label: 'Give your review', to: `/assessments/${s.assessmentId}/review`, mark: 'review' };
  if (s.assessmentId) return { label: 'View assessment', to: `/assessments/${s.assessmentId}`, mark: s.state === 'REVIEW_READY' ? 'review' : undefined };
  if (STOPPED_STATES.has(s.state)) return { label: 'See what happened', to: `/interviews/${s.id}`, mark: 'urgent' };
  if (isAwaitingCandidate(s.state)) return { label: 'Check the invitation', to: `/interviews/${s.id}`, mark: 'waiting' };
  if (isUnderway(s.state)) return { label: 'Open the live interview', to: `/interviews/${s.id}`, mark: 'live' };
  return { label: 'Open interview', to: `/interviews/${s.id}` };
}

export interface RoleCardSource {
  readonly id: string;
  readonly awaitingReview: number;
}

export function roleNextAction(r: RoleCardSource): NextAction {
  if (r.awaitingReview > 0) {
    return { label: `${r.awaitingReview} interview${r.awaitingReview === 1 ? '' : 's'} to review`, to: `/roles/${r.id}`, mark: 'review' };
  }
  return { label: 'Open role', to: `/roles/${r.id}` };
}
