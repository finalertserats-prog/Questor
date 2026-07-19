// Interview session state machine (BRD Section 14.3).

export const SESSION_STATES = [
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING', 'CONNECTING',
  'DISCLOSURE', 'CONSENTED', 'WARMUP', 'ASSESSING', 'CANDIDATE_QUESTIONS',
  'CLOSING', 'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED',
] as const;

export const EXCEPTION_STATES = [
  'RESCHEDULE_REQUIRED', 'NO_SHOW', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE',
  'POLICY_STOP', 'MANUAL_HANDOFF', 'CANCELLED',
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
  DISCLOSURE: ['CONSENTED', 'CANDIDATE_WITHDREW', 'MANUAL_HANDOFF'],
  CONSENTED: ['WARMUP', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE'],
  WARMUP: ['ASSESSING', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE', 'POLICY_STOP'],
  ASSESSING: ['CANDIDATE_QUESTIONS', 'CLOSING', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'MANUAL_HANDOFF'],
  CANDIDATE_QUESTIONS: ['CLOSING', 'TECHNICAL_FAILURE'],
  CLOSING: ['PROCESSING'],
  PROCESSING: ['REVIEW_READY', 'TECHNICAL_FAILURE'],
  REVIEW_READY: ['HUMAN_REVIEWED'],
  HUMAN_REVIEWED: ['CLOSED'],
  // exception recovery
  RESCHEDULE_REQUIRED: ['INVITED', 'ACCEPTED', 'CANCELLED'],
  TECHNICAL_FAILURE: ['RESCHEDULE_REQUIRED', 'CONNECTING', 'CANCELLED'],
  MANUAL_HANDOFF: ['CLOSED'],
  POLICY_STOP: ['MANUAL_HANDOFF', 'CLOSED'],
  NO_SHOW: ['RESCHEDULE_REQUIRED', 'CLOSED'],
  CANDIDATE_WITHDREW: ['CLOSED'],
};

export function canTransition(from: string, to: string): boolean {
  return (FORWARD[from] ?? []).includes(to);
}

export function assertTransition(from: string, to: string): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal interview state transition: ${from} -> ${to}`);
  }
}

export function isTerminal(state: string): boolean {
  return state === 'CLOSED' || state === 'CANCELLED';
}
