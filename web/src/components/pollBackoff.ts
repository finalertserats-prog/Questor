/**
 * How long to wait before asking again, for the pages that poll. Kept free of
 * React so it can be unit tested (see web/tests/pollBackoff.test.ts).
 */

/** The normal cadence while everything is answering. */
export const POLL_DELAY_MS = 3000;

/** The longest gap a failing poll backs off to; recovery still arrives on its own. */
export const MAX_POLL_DELAY_MS = 30_000;

/**
 * The wait after a failed poll: twice the last one, capped.
 *
 * WHY back off rather than keep the cadence: the usual cause of a failed poll
 * is a server under load or restarting, and hammering it every three seconds
 * from every open tab is exactly the wrong response. WHY not simply stop: a
 * blip that ends a minute later should not leave a live transcript frozen with
 * no way back short of a reload.
 */
export function nextPollDelay(previous: number): number {
  if (!Number.isFinite(previous) || previous <= 0) return POLL_DELAY_MS;
  return Math.min(MAX_POLL_DELAY_MS, previous * 2);
}
