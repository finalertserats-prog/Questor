/**
 * The scheduling picker's logic, kept free of React so it can be unit tested
 * (see web/tests/zonedScheduleModel.test.ts).
 *
 * WHY: a datetime-local input is read in the BROWSER's zone. A recruiter in
 * London booking 14:30 for a candidate in Bengaluru got London's 14:30, and
 * nothing on screen said so. The picker now asks for the zone first and sends
 * the date, time and zone as picked; the server converts. The conversion here
 * only drives the preview and the "already passed" check.
 */

import { effectiveOrgTimeZone } from './orgTimeZone';

export interface ScheduleDraft {
  readonly timeZone: string;
  readonly date: string;
  readonly time: string;
}

export type ZonedResult =
  | { readonly ok: true; readonly at: Date }
  | { readonly ok: false; readonly reason: 'invalid' | 'gap' };

export type SchedulePreview =
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'problem'; readonly text: string }
  | { readonly kind: 'ok'; readonly at: Date; readonly text: string };

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY_MS = 86_400_000;

function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function wallClockAsUtc(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/**
 * "YYYY-MM-DDTHH:mm" in a zone to the instant it names. The same rule as the
 * server (services/zonedTime.ts): a skipped time is a gap, a repeated one
 * takes the earlier instant.
 */
export function zonedLocalToUtc(local: string, timeZone: string): ZonedResult {
  const match = LOCAL_PATTERN.exec(local);
  if (!match || !isKnownTimeZone(timeZone)) return { ok: false, reason: 'invalid' };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(asUtc);
  // Years 0-99 are read as 1900-1999 by Date.UTC: refused rather than moved.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return { ok: false, reason: 'invalid' };

  const offsets = new Set([asUtc - DAY_MS, asUtc, asUtc + DAY_MS].map((probe) => wallClockAsUtc(probe, timeZone) - probe));
  const matches = [...offsets]
    .map((offset) => asUtc - offset)
    .filter((candidate) => wallClockAsUtc(candidate, timeZone) === asUtc)
    .sort((a, b) => a - b);
  return matches.length > 0 ? { ok: true, at: new Date(matches[0]) } : { ok: false, reason: 'gap' };
}

// ICU still lists some zones under names the cities dropped years ago, so
// Chrome offers "Asia/Calcutta". People search for the name they know; both
// spellings name the same zone, and the server accepts either.
const CURRENT_NAMES: Readonly<Record<string, string>> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** A zone under the name people know it by today. */
export function currentZoneName(timeZone: string): string {
  const renamed = CURRENT_NAMES[timeZone];
  return renamed && isKnownTimeZone(renamed) ? renamed : timeZone;
}

/** Every zone the browser knows, under current names, UTC included (some browsers leave it out). */
export function listTimeZones(): readonly string[] {
  const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const named = [...new Set(supported.map(currentZoneName))];
  return named.includes('UTC') ? named : ['UTC', ...named];
}

/** Whether the value names a zone — asked of Intl, which knows every alias the list leaves out. */
export function isValidTimeZone(value: string): boolean {
  return value.trim() !== '' && value.includes('/') ? isKnownTimeZone(value) : value === 'UTC';
}

/** "GMT+5:30" — the offset a zone is on at that moment, for the list. */
export function timeZoneOptionLabel(timeZone: string, at: Date): string {
  const part = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(at).find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

/** The organisation's zone, IST when it has none — never this browser's. */
export function initialTimeZone(orgZone: string | null | undefined): string {
  return currentZoneName(effectiveOrgTimeZone(orgZone));
}

function clock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

function day(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(at);
}

function sameClock(at: Date, a: string, b: string): boolean {
  return wallClockAsUtc(at.getTime(), a) === wallClockAsUtc(at.getTime(), b);
}

/**
 * What the picked time means, in words: "Thu, 1 Oct 2026, 14:30 in
 * Asia/Kolkata (GMT+5:30) = 09:00 UTC", plus the viewer's own clock when it
 * differs. Or why it cannot be booked.
 */
export function schedulePreview(draft: ScheduleDraft, now: Date, viewerZone: string | undefined): SchedulePreview {
  if (!draft.timeZone || !draft.date || !draft.time) return { kind: 'incomplete' };
  if (!isValidTimeZone(draft.timeZone)) {
    return { kind: 'problem', text: `"${draft.timeZone}" is not a time zone. Pick one from the list, such as Asia/Kolkata.` };
  }
  const result = zonedLocalToUtc(`${draft.date}T${draft.time}`, draft.timeZone);
  if (!result.ok) {
    return result.reason === 'gap'
      ? { kind: 'problem', text: `${draft.time} on ${draft.date} does not exist in ${draft.timeZone}: the clocks go forward then. Pick a time an hour later.` }
      : { kind: 'problem', text: 'That is not a real date and time.' };
  }
  if (result.at.getTime() <= now.getTime()) {
    return { kind: 'problem', text: 'That time has already passed. Pick a date and time in the future.' };
  }
  const offset = timeZoneOptionLabel(draft.timeZone, result.at);
  const base = `${day(result.at, draft.timeZone)}, ${clock(result.at, draft.timeZone)} in ${draft.timeZone} (${offset}) = ${clock(result.at, 'UTC')} UTC`;
  const viewer = viewerZone && isKnownTimeZone(viewerZone) && !sameClock(result.at, viewerZone, draft.timeZone)
    ? ` · ${clock(result.at, viewerZone)} your time`
    : '';
  return { kind: 'ok', at: result.at, text: `${base}${viewer}` };
}

/** The request body the scheduling routes take. */
export function scheduleRequest(draft: ScheduleDraft): { date: string; time: string; timeZone: string } {
  return { date: draft.date, time: draft.time, timeZone: draft.timeZone };
}

/** This browser's zone, when it will say. */
export function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
