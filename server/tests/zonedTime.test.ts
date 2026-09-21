import { describe, it, expect } from 'vitest';
import { formatScheduledTime, zonedLocalToUtc } from '../src/services/zonedTime.js';

/**
 * A recruiter picks a wall-clock time in the candidate's zone ("14:30 in
 * Kolkata"). The browser used to turn that into UTC through its OWN zone, so a
 * recruiter in London booking for Bengaluru silently booked London's 14:30.
 * The conversion now happens here, from the zone that was chosen.
 */

const utc = (local: string, zone: string) => {
  const result = zonedLocalToUtc(local, zone);
  return result.ok ? result.at.toISOString() : result.reason;
};

describe('turning a wall-clock time in a zone into an instant', () => {
  it('handles a zone with no daylight saving', () => {
    expect(utc('2026-10-01T14:30', 'Asia/Kolkata')).toBe('2026-10-01T09:00:00.000Z');
  });

  it('handles London in winter', () => {
    expect(utc('2026-01-15T09:00', 'Europe/London')).toBe('2026-01-15T09:00:00.000Z');
  });

  it('handles London in summer', () => {
    expect(utc('2026-07-15T09:00', 'Europe/London')).toBe('2026-07-15T08:00:00.000Z');
  });

  it('handles New York in winter', () => {
    expect(utc('2026-01-15T09:00', 'America/New_York')).toBe('2026-01-15T14:00:00.000Z');
  });

  it('handles New York in summer', () => {
    expect(utc('2026-07-15T09:00', 'America/New_York')).toBe('2026-07-15T13:00:00.000Z');
  });

  it('refuses a London time skipped by the spring change', () => {
    expect(utc('2026-03-29T01:30', 'Europe/London')).toBe('gap');
  });

  it('refuses a New York time skipped by the spring change', () => {
    expect(utc('2026-03-08T02:30', 'America/New_York')).toBe('gap');
  });

  it('takes the earlier of a London time that happens twice in autumn', () => {
    expect(utc('2026-10-25T01:30', 'Europe/London')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('takes the earlier of a New York time that happens twice in autumn', () => {
    expect(utc('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('accepts the first minute after the London spring change', () => {
    expect(utc('2026-03-29T02:00', 'Europe/London')).toBe('2026-03-29T01:00:00.000Z');
  });

  it('refuses a date that does not exist', () => {
    expect(utc('2026-02-30T09:00', 'Asia/Kolkata')).toBe('invalid');
  });

  it('refuses a two-digit year rather than reading it as the 1900s', () => {
    expect(utc('0099-01-01T09:00', 'UTC')).toBe('invalid');
  });

  it('refuses a malformed time', () => {
    expect(utc('2026-02-10T9:00', 'Asia/Kolkata')).toBe('invalid');
  });

  it('refuses a zone the runtime does not know', () => {
    expect(utc('2026-02-10T09:00', 'Mars/Olympus_Mons')).toBe('invalid');
  });
});

describe('writing a scheduled time down for an email', () => {
  const AT = new Date('2026-10-01T09:00:00.000Z');

  it('states the time in the chosen zone', () => {
    expect(formatScheduledTime(AT, 'Asia/Kolkata')).toContain('14:30');
  });

  it('names the zone', () => {
    expect(formatScheduledTime(AT, 'Asia/Kolkata')).toContain('Asia/Kolkata');
  });

  it('gives UTC alongside, so either reader can check it', () => {
    expect(formatScheduledTime(AT, 'Asia/Kolkata')).toContain('09:00 UTC');
  });

  it('does not repeat UTC when the zone already is UTC', () => {
    expect(formatScheduledTime(AT, 'UTC').match(/UTC/g)?.length).toBe(1);
  });

  it('falls back to UTC, labelled, when there is no zone', () => {
    expect(formatScheduledTime(AT, null)).toBe('2026-10-01T09:00:00+00:00 (UTC)');
  });
});
