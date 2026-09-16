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
