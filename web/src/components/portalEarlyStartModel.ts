/**
 * What the portal says to a candidate who opens a booked interview early.
 * Kept free of React so it can be unit tested
 * (see web/tests/portalEarlyStartModel.test.ts).
 *
 * WHY a note and not a lock: the owner's call (2026-09-21) — candidates take
 * it when it suits them. The booked time is stated so nobody starts early by
 * mistake, and starting stays open.
 */

/** Within this long before the booked time a candidate is on time, not early. */
export const EARLY_START_GRACE_MS = 10 * 60_000;

export interface PortalBooking {
  /** The booked instant, as ISO. */
  readonly at: string;
  /** The booked time in the zone it was booked in, as the server wrote it. */
  readonly text: string;
}

export function earlyStartNote(schedule: PortalBooking | null | undefined, now: Date): string | null {
  if (!schedule) return null;
  const at = Date.parse(schedule.at);
  if (Number.isNaN(at) || now.getTime() >= at - EARLY_START_GRACE_MS) return null;
  return `Your interview is booked for ${schedule.text}. You can start now if that suits you better.`;
}
