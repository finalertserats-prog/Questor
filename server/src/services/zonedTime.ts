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

/**
 * The zone's wall clock at an instant as "YYYY-MM-DDTHH:mm:ss", with no
 * offset: the form calendar APIs pair with a zone name (Graph's dateTime).
 */
export function zonedWallClock(at: Date, timeZone: string): string {
  return new Date(wallClockAsUtc(at.getTime(), timeZone)).toISOString().slice(0, 19);
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
  // Date.UTC rolls 30 February over into March, and reads years 0-99 as
  // 1900-1999; a date that moved did not exist as typed.
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day || hour > 23 || minute > 59) {
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

/**
 * The same instant on the candidate's own clock, for a reader who has been
 * told the time in somebody else's zone.
 *
 * Null — no sentence at all — when their zone is unknown, or is the zone the
 * time was already stated in. Restating the booking zone as "your own clock"
 * to someone it is not would sound checked when it is a guess, which is the
 * whole failure this work exists to stop.
 */
export function candidateClockSentence(at: Date, statedZone: string, candidateZone: string | null | undefined): string | null {
  if (!candidateZone || !isKnownTimeZone(candidateZone) || candidateZone === statedZone) return null;
  return `That is ${formatRoundTime(at, candidateZone)}, on your own clock.`;
}

/**
 * Where the zone a time is stated in came from. The same four cases
 * services/scheduleZone.ts distinguishes, and for the same reason: an
 * organisation that chose Asia/Kolkata and one that chose nothing both work in
 * IST, but only the first has been asked.
 */
export type StatedZoneSource = 'booked' | 'candidate' | 'org' | 'org_default';

/**
 * The line under a booked time that says whose clock it is on.
 *
 * A time zone is the one fact in an invitation that can be wrong while looking
 * completely right: "14:30" reads as the reader's own 14:30 unless something
 * says otherwise, and a candidate who reads a Kolkata booking as a London one
 * misses their interview and never learns why. So there is always a second
 * line, and it always names a zone:
 *
 *   - their zone is known and different — the same instant on their clock;
 *   - their zone is known and is the one already stated — said so, because
 *     silence there is indistinguishable from the case below;
 *   - their zone is not known — the absence is reported rather than papered
 *     over, and the zone actually used is named, attributed only as far as the
 *     truth goes. Nobody chose `org_default`; claiming it is the
 *     organisation's would invent a decision they never made.
 */
export function secondClockLine(o: {
  readonly at: Date;
  readonly statedZone: string;
  readonly candidateZone: string | null | undefined;
  readonly source: StatedZoneSource;
  readonly companyName: string;
}): string {
  const theirs = candidateClockSentence(o.at, o.statedZone, o.candidateZone);
  if (theirs) return theirs;
  if (o.candidateZone && isKnownTimeZone(o.candidateZone)) {
    return `The time above is in ${o.statedZone}, which is your own time zone.`;
  }
  const whose = whoseZone(o.source, o.statedZone, o.companyName);
  return `We do not have your time zone, so the time above is written in ${whose}. Please check it against your own clock.`;
}

function whoseZone(source: StatedZoneSource, zone: string, companyName: string): string {
  const company = companyName.trim();
  switch (source) {
    case 'booked': return `${zone}, the zone this interview was booked in`;
    // Reached only from the branch above, which is the branch that has just
    // said we do not have the reader's zone. Attributing it to them in the
    // same sentence would contradict it, so it is named and left alone — the
    // stored value is not the one in front of the reader either way.
    case 'candidate': return zone;
    case 'org': return company ? `${zone}, ${company}'s time zone` : `${zone}, the organisation's time zone`;
    // Nobody chose it. It is named and left unattributed on purpose.
    case 'org_default': return zone;
  }
}
