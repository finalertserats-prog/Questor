// Interview session state machine (BRD Section 14.3).

import { HttpError } from '../middleware/index.js';

export const SESSION_STATES = [
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING', 'CONNECTING',
  'DISCLOSURE', 'CONSENTED', 'WARMUP', 'ASSESSING', 'CANDIDATE_QUESTIONS',
  'CLOSING', 'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED',
] as const;

export const EXCEPTION_STATES = [
  'RESCHEDULE_REQUIRED', 'NO_SHOW', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE',
  'POLICY_STOP', 'MANUAL_HANDOFF', 'CANCELLED',
  // The interview started and stopped part-way, for a reason nobody recorded.
  // Neutral on purpose: the cause is as often ours as theirs — one candidate
  // reached exactly one turn because a broken button would not let him answer —
  // and a state name that blames the candidate becomes the reviewer's first
  // impression of them. NO_SHOW never arrived, CANDIDATE_WITHDREW asked to
  // stop, TECHNICAL_FAILURE asserts a cause we do not know.
  // Never carries a score: see services/incompleteInterviews.ts.
  'INCOMPLETE',
] as const;

export type SessionState = (typeof SESSION_STATES)[number] | (typeof EXCEPTION_STATES)[number];

// Allowed forward transitions. Exception states are reachable from most live states.
const FORWARD: Record<string, string[]> = {
  PROVISIONED: ['INVITED', 'CANCELLED'],
  INVITED: ['ACCEPTED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULE_REQUIRED'],
  ACCEPTED: ['READY_CHECK', 'RESCHEDULE_REQUIRED', 'CANCELLED', 'NO_SHOW'],
  READY_CHECK: ['WAITING', 'CONNECTING', 'TECHNICAL_FAILURE', 'RESCHEDULE_REQUIRED'],
  WAITING: ['CONNECTING', 'NO_SHOW', 'RESCHEDULE_REQUIRED'],
  CONNECTING: ['DISCLOSURE', 'TECHNICAL_FAILURE'],
  DISCLOSURE: ['CONSENTED', 'CANDIDATE_WITHDREW', 'MANUAL_HANDOFF', 'INCOMPLETE'],
  CONSENTED: ['WARMUP', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE', 'INCOMPLETE'],
  // RESCHEDULE_REQUIRED from the live states: the candidate said "can we do
  // this later?". It is neither a withdrawal nor an unexplained stop — they
  // still want the interview — and it is the state the recruiter's re-invite
  // already starts from (interviewEngine postponeInterview).
  // MANUAL_HANDOFF from every state the candidate can speak in: "can I do this
  // with a person instead?" is the one thing the consent page explicitly
  // promises, and a promise that only holds in ASSESSING is not a promise. It
  // was already reachable there and from DISCLOSURE (the accommodation box);
  // the two live states either side of it had no route, so the same sentence
  // said one question too early or one question too late did nothing at all.
  WARMUP: ['ASSESSING', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'MANUAL_HANDOFF', 'INCOMPLETE', 'RESCHEDULE_REQUIRED'],
  ASSESSING: ['CANDIDATE_QUESTIONS', 'CLOSING', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'MANUAL_HANDOFF', 'INCOMPLETE', 'RESCHEDULE_REQUIRED'],
  CANDIDATE_QUESTIONS: ['CLOSING', 'TECHNICAL_FAILURE', 'MANUAL_HANDOFF', 'RESCHEDULE_REQUIRED'],
  // TECHNICAL_FAILURE is reachable because a finalisation can die between the
  // CLOSING transition and the PROCESSING one. Without it the recovery sweep had
  // no legal move for such a session and it stayed in CLOSING for ever.
  CLOSING: ['PROCESSING', 'TECHNICAL_FAILURE'],
  PROCESSING: ['REVIEW_READY', 'TECHNICAL_FAILURE'],
  REVIEW_READY: ['HUMAN_REVIEWED'],
  HUMAN_REVIEWED: ['CLOSED'],
  // exception recovery
  RESCHEDULE_REQUIRED: ['INVITED', 'ACCEPTED', 'CANCELLED'],
  // CLOSED is how a no-fault retake retires the failed attempt it replaces.
  TECHNICAL_FAILURE: ['RESCHEDULE_REQUIRED', 'CONNECTING', 'CANCELLED', 'CLOSED'],
  MANUAL_HANDOFF: ['CLOSED'],
  POLICY_STOP: ['MANUAL_HANDOFF', 'CLOSED'],
  NO_SHOW: ['RESCHEDULE_REQUIRED', 'CLOSED'],
  CANDIDATE_WITHDREW: ['CLOSED'],
  // Re-invitable, and the invitation is deliberately NOT burned, so a candidate
  // whose network dropped can return to the same link. CLOSING is the one way
  // into scoring: a reviewer explicitly deciding the partial transcript is fair
  // to assess (POST /interviews/:id/assess-partial). Without it that endpoint
  // could only ever fail.
  INCOMPLETE: ['RESCHEDULE_REQUIRED', 'CLOSED', 'CLOSING'],
};

export function canTransition(from: string, to: string): boolean {
  return (FORWARD[from] ?? []).includes(to);
}

/**
 * A 409, not a plain Error. Every caller reaches this from a request about a
 * session whose state someone else (the candidate, a sweep, another recruiter)
 * may have just changed — that is a conflict the caller can act on, and as a
 * bare Error it surfaced as an unexplained 500.
 */
export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) {
    throw new HttpError(409, `This interview is ${from}, so it cannot be moved to ${to}.`, 'illegal_transition');
  }
}

export function isTerminal(state: string): boolean {
  return state === 'CLOSED' || state === 'CANCELLED';
}
