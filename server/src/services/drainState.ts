import { HttpError } from '../middleware/index.js';

/**
 * Whether this process has begun shutting down.
 *
 * Set once by the signal handler and never cleared: a draining process is on
 * its way out, and the only thing that ends a drain is the exit. Read by the
 * health check (so a deploy can tell the old process from the new one) and by
 * every path that would start an interview this process is about to abandon.
 */
let draining = false;

/** Seconds a refused client is told to wait before trying again. */
export const DRAIN_RETRY_AFTER_SECONDS = 120;

/**
 * Candidate-facing. This is read by someone about to be interviewed, so it says
 * what is happening and what to do, and does not read as a crash or a verdict.
 */
export const SERVER_RESTARTING_MESSAGE =
  'Questor is installing a short update. Your interview has not started and nothing is lost — please try again in a couple of minutes.';

export function isDraining(): boolean {
  return draining;
}

export function markDraining(): void {
  draining = true;
}

/** Thrown where a new interview would otherwise begin on a draining process. */
export function assertAcceptingNewInterviews(): void {
  if (draining) throw new HttpError(503, SERVER_RESTARTING_MESSAGE, { retryAfterSeconds: DRAIN_RETRY_AFTER_SECONDS });
}

/** Test hook. */
export function _resetDraining(): void {
  draining = false;
}
