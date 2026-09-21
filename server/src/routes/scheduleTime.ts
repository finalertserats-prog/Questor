import { z } from 'zod';
import { HttpError } from '../middleware/index.js';
import { isKnownTimeZone } from '../services/roundTime.js';
import { zonedLocalToUtc } from '../services/zonedTime.js';

/**
 * The two ways a scheduled time arrives.
 *
 * The console sends what the recruiter picked — a date, a time and the zone
 * they are in — and the server converts it. The older form, one offset-aware
 * instant, still works for API clients; it records no zone.
 */
export const scheduleTimeFields = {
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01.').optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Use a 24-hour time like 14:30.').optional(),
  timeZone: z.string().trim().max(64).refine(isKnownTimeZone, 'Use an IANA time zone such as "Asia/Kolkata".').optional(),
};

type ScheduleTimeInput = { scheduledAt?: string; date?: string; time?: string; timeZone?: string };

export interface ResolvedTime {
  readonly at: Date;
  /** Null for the older offset-only form. */
  readonly timeZone: string | null;
}

/** The instant and zone a request names, or a 400 that says what to fix. */
export function resolveScheduleTime(input: ScheduleTimeInput): ResolvedTime {
  const { scheduledAt, date, time, timeZone } = input;
  const zoned = date !== undefined || time !== undefined || timeZone !== undefined;
  if (scheduledAt && zoned) throw new HttpError(400, 'Send either a date, time and time zone, or scheduledAt, not both.');
  if (scheduledAt) return { at: new Date(scheduledAt), timeZone: null };
  if (!date || !time || !timeZone) throw new HttpError(400, 'Choose a time zone, a date and a time.');

  const result = zonedLocalToUtc(`${date}T${time}`, timeZone);
  if (result.ok) return { at: result.at, timeZone };
  if (result.reason === 'gap') {
    throw new HttpError(400, `${time} on ${date} does not exist in ${timeZone}: the clocks go forward then. Pick a time an hour later.`);
  }
  throw new HttpError(400, `${date} ${time} is not a real date and time.`);
}

/** Refuses a time that has already gone: it reaches someone as an invitation to the past. */
export function assertInFuture(at: Date, now: Date = new Date()): void {
  if (at.getTime() <= now.getTime()) throw new HttpError(400, 'That time has already passed. Pick a date and time in the future.');
}
