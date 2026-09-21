import { formatRoundTime, isKnownTimeZone } from './roundTime.js';

/**
 * Wall-clock times in a named zone, converted with Intl alone.
 *
 * A recruiter books "14:30 in Kolkata". The browser used to convert that
 * through its own zone, so booking from London for Bengaluru silently booked
 * London's 14:30. The zone the recruiter chose is now what the time is read in.
 */

export type ZonedResult =
  | { readonly ok: true; readonly at: Date }
  // 'gap': the clocks jumped over that time (spring change), so it never happens.
  | { readonly ok: false; readonly reason: 'invalid' | 'gap' };

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  partsFormatters.set(timeZone, created);
  return created;
}

/** The zone's wall clock at an instant, written as if that clock were UTC. */
function wallClockAsUtc(at: number, timeZone: string): number {
  const parts = Object.fromEntries(partsFormatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/** How far the zone's clock is ahead of UTC at an instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  return wallClockAsUtc(at, timeZone) - Math.floor(at / 1000) * 1000;
}

/**
 * "YYYY-MM-DDTHH:mm" in an IANA zone to the instant it names.
 *
 * Every offset the zone uses within a day either side is tried; the ones whose
 * instant reads back as the same wall clock are real. None means the time was
 * skipped (a gap); two means it happens twice (an overlap) and the earlier is
 * taken, because turning up an hour early beats missing the interview.
 */
export function zonedLocalToUtc(local: string, timeZone: string): ZonedResult {
  const match = LOCAL_PATTERN.exec(local);
  if (!match || !isKnownTimeZone(timeZone)) return { ok: false, reason: 'invalid' };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const roundTrip = new Date(asUtc);
  // Date.UTC rolls 30 February over into March; a date that moved did not exist.
  if (roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day || hour > 23 || minute > 59) {
    return { ok: false, reason: 'invalid' };
  }

  const offsets = new Set([asUtc - DAY_MS, asUtc, asUtc + DAY_MS].map((probe) => offsetAt(probe, timeZone)));
  const matches = [...offsets]
    .map((offset) => asUtc - offset)
    .filter((candidate) => wallClockAsUtc(candidate, timeZone) === asUtc)
    .sort((a, b) => a - b);
  return matches.length > 0 ? { ok: true, at: new Date(matches[0]) } : { ok: false, reason: 'gap' };
}

const UTC_NAMES: ReadonlySet<string> = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT']);

const UTC_CLOCK =new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * A scheduled time for the person who has to turn up: in the zone it was booked
 * in, with UTC alongside so a reader somewhere else can check their own clock.
 * No zone falls back to an explicit UTC time, never a bare local one.
 */
export function formatScheduledTime(at: Date, timeZone: string | null | undefined): string {
  const zone = timeZone && isKnownTimeZone(timeZone) ? timeZone : undefined;
  const inZone = formatRoundTime(at, zone);
  if (!zone || UTC_NAMES.has(zone)) return inZone;
  return `${inZone} · ${UTC_CLOCK.format(at)} UTC`;
}
