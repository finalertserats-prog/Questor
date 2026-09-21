/**
 * One way of writing a date down. Kept free of React so it can be unit tested
 * (see web/tests/dateFormat.test.ts).
 *
 * WHY it is shared: the console showed five different formats for the same
 * instant — a bare toLocaleString here, a toLocaleDateString there — and none
 * of them named a time zone. A hiring team spread across offices was reading
 * interview times with no way to tell whose clock they were on.
 */

import { NO_SCORE } from './scoreFormat';

function parse(value: unknown): Date | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Date and time, with the zone it is stated in. A dash when there is no date. */
export function formatDateTime(value: unknown): string {
  const at = parse(value);
  if (!at) return NO_SCORE;
  // Spelled out field by field rather than with dateStyle/timeStyle: the two
  // cannot be combined with timeZoneName, and the zone is the point.
  return at.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

/** Just the day, for a column where the time is noise. */
export function formatDate(value: unknown): string {
  const at = parse(value);
  return at ? at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : NO_SCORE;
}

function knownZone(timeZone: string | null | undefined): string | null {
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

function clockIn(at: Date, timeZone: string): string {
  return at.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/**
 * A scheduled time, on the clock it was booked on.
 *
 * The zone is the booking's own, else the organisation's, else UTC — and it is
 * always named. Never the viewer's clock silently: the viewer's own time is
 * added in brackets when it differs, so nobody converts in their head.
 */
export function formatScheduled(
  value: unknown,
  storedZone: string | null | undefined,
  orgZone: string | null | undefined,
  viewerZone: string | undefined = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const at = parse(value);
  if (!at) return NO_SCORE;
  const zone = knownZone(storedZone) ?? knownZone(orgZone);
  const dayPart = at.toLocaleDateString('en-GB', { timeZone: zone ?? 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  if (!zone) return `${dayPart}, ${clockIn(at, 'UTC')} UTC`;
  const offset = at.toLocaleString('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' }).split(' ').pop() ?? '';
  const main = `${dayPart}, ${clockIn(at, zone)} ${offset} (${zone})`;
  const viewer = knownZone(viewerZone);
  return viewer && clockIn(at, viewer) !== clockIn(at, zone) ? `${main} (${clockIn(at, viewer)} your time)` : main;
}
