/**
 * The one decision the session check has to get right, kept free of React so it
 * can be unit tested (see web/tests/authModel.test.ts).
 */

import { ApiError } from './api/client';

/** The statuses that mean the credential itself is no longer good. */
const SESSION_ENDING_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Should this failed /auth/me check end the session?
 *
 * WHY: only the server refusing the credential says anything about the
 * session. A 500, a proxy blip while the API restarts, or a timeout says
 * something about the network — and treating those as "signed out" threw
 * people back to the login page mid-task, losing whatever they were doing, for
 * a fault that was over a second later.
 */
export function endsSession(error: unknown): boolean {
  return error instanceof ApiError && SESSION_ENDING_STATUSES.has(error.status);
}

const FALLBACK = 'We could not check your sign-in.';

/** What to tell someone whose session check failed for a reason worth retrying. */
export function sessionLoadMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return FALLBACK;
}
