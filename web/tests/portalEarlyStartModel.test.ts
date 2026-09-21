import { describe, it, expect } from 'vitest';
import { earlyStartNote } from '../src/components/portalEarlyStartModel';

// Starting before the booked time is allowed (owner's call, 2026-09-21): the
// candidate is told, calmly, and nothing is blocked.
const AT = '2026-10-01T09:00:00.000Z';
const TEXT = 'Thursday 1 October 2026 at 14:30 GMT+5:30 (Asia/Kolkata) · 1 Oct, 09:00 UTC';
const schedule = { at: AT, text: TEXT };
const minutesBefore = (m: number) => new Date(Date.parse(AT) - m * 60_000);

describe('earlyStartNote', () => {
  it('tells an early candidate when they are booked for, and that they may start', () => {
    expect(earlyStartNote(schedule, minutesBefore(60))).toBe(`Your interview is booked for ${TEXT}. You can start now if that suits you better.`);
  });

  it('says nothing within ten minutes of the booked time', () => {
    expect(earlyStartNote(schedule, minutesBefore(10))).toBeNull();
  });

  it('says nothing after the booked time', () => {
    expect(earlyStartNote(schedule, minutesBefore(-5))).toBeNull();
  });

  it('says nothing when no time was booked', () => {
    expect(earlyStartNote(null, minutesBefore(60))).toBeNull();
  });

  it('says nothing when the booked time cannot be read', () => {
    expect(earlyStartNote({ at: 'not a date', text: TEXT }, minutesBefore(60))).toBeNull();
  });
});
