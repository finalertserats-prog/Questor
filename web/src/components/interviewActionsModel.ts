import { can, type CapabilityHolder } from './capabilityModel';

/**
 * Which lifecycle actions the interview page offers.
 *
 * The server says what the interview's STATE allows (GET /interviews/:id
 * `actions`, built from the same rules its action routes enforce); the user's
 * capabilities say whether THIS person may do it. A button needs both, or it
 * only ever answers 409 or 403.
 */
export interface StateActions {
  readonly cancel: boolean;
  readonly schedule: boolean;
  readonly retake: boolean;
  readonly assessPartial: boolean;
  readonly reopen: boolean;
}

export interface InterviewActions extends StateActions {
  /** Send, resend or copy the invitation. */
  readonly invite: boolean;
}

// Only for a server that does not send `actions` yet: the states the state
// machine lets move to CANCELLED, and the ones /schedule accepts.
const CANCELLABLE = new Set(['PROVISIONED', 'INVITED', 'ACCEPTED', 'RESCHEDULE_REQUIRED', 'TECHNICAL_FAILURE']);
const SCHEDULABLE = new Set(['PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING', 'DISCLOSURE', 'CONSENTED', 'RESCHEDULE_REQUIRED']);

function fallbackActions(state: string): StateActions {
  return { cancel: CANCELLABLE.has(state), schedule: SCHEDULABLE.has(state), retake: false, assessPartial: false, reopen: false };
}

export function interviewActions(state: string, fromServer: StateActions | undefined, user: CapabilityHolder | null | undefined): InterviewActions {
  const allowed = fromServer ?? fallbackActions(state);
  return {
    cancel: allowed.cancel && can(user, 'interview:schedule'),
    schedule: allowed.schedule && can(user, 'interview:schedule'),
    retake: allowed.retake && can(user, 'interview:invite'),
    assessPartial: allowed.assessPartial && can(user, 'interview:drive'),
    reopen: allowed.reopen && can(user, 'interview:invite'),
    invite: can(user, 'interview:invite'),
  };
}

/** Every one of these is recorded with a reason; the server wants ten characters. */
export const MIN_REASON_LENGTH = 10;

export interface AccommodationRequest {
  readonly text: string;
  readonly requestedAt: string | null;
}

/** The accommodation a candidate asked for, from the session's consent record. */
export function accommodationRequestOf(consent: unknown): AccommodationRequest | null {
  if (typeof consent !== 'object' || consent === null) return null;
  const record = consent as Record<string, unknown>;
  const text = typeof record.accommodationRequest === 'string' ? record.accommodationRequest.trim() : '';
  if (!text) return null;
  const at = record.accommodationRequestedAt;
  return { text, requestedAt: typeof at === 'string' ? at : null };
}
