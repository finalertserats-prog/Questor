import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatScheduled } from '../src/components/dateFormat';

// Locale and time zone belong to whoever is reading, so these check what the
// helper decides — is there a date, does it name a zone — not one machine's
// rendering of it.
describe('formatDateTime', () => {
  it('writes a real instant out', () => {
    const shown = formatDateTime('2026-06-01T09:30:00.000Z');
    expect(shown).toContain('2026');
    expect(shown).not.toContain('Invalid');
  });

  it('names the time zone, so a distributed team knows whose clock it is', () => {
    expect(formatDateTime('2026-06-01T09:30:00.000Z').trim().split(/\s+/).length).toBeGreaterThan(3);
  });

  it('accepts a Date as readily as a string', () => {
    expect(formatDateTime(new Date('2026-06-01T09:30:00.000Z'))).toContain('2026');
  });

  // "Invalid Date" on screen is how a missing timestamp used to look.
  it('shows a dash when there is no date', () => {
    expect([formatDateTime(null), formatDateTime(undefined), formatDateTime('')]).toEqual(['—', '—', '—']);
  });

  it('shows a dash for something that is not a date at all', () => {
    expect([formatDateTime('not a date'), formatDateTime(42)]).toEqual(['—', '—']);
  });
});

describe('formatDate', () => {
  it('writes the day without the time', () => {
    const shown = formatDate('2026-06-01T09:30:00.000Z');
    expect(shown).toContain('2026');
    expect(shown).not.toMatch(/\d:\d\d/);
  });

  it('shows a dash when there is no date', () => {
    expect(formatDate(null)).toBe('—');
  });
});

// A scheduled time is read on the clock it was booked on, never silently on
// the viewer's: stored zone, then the organisation's, then UTC, labelled.
describe('formatScheduled', () => {
  const AT = '2026-10-01T09:00:00.000Z';

  it('states the time in the zone it was booked in', () => {
    expect(formatScheduled(AT, 'Asia/Kolkata', null, 'Asia/Kolkata')).toContain('14:30');
  });

  it('names that zone', () => {
    expect(formatScheduled(AT, 'Asia/Kolkata', null, 'Asia/Kolkata')).toContain('Asia/Kolkata');
  });

  it('prefers the booked zone over the organisation zone', () => {
    expect(formatScheduled(AT, 'America/New_York', 'Asia/Kolkata', 'America/New_York')).toContain('05:00');
  });

  it('falls back to the organisation zone for a time booked without one', () => {
    expect(formatScheduled(AT, null, 'Asia/Kolkata', 'Asia/Kolkata')).toContain('14:30');
  });

  it('falls back to UTC, labelled, when there is no zone at all', () => {
    expect(formatScheduled(AT, null, null, 'UTC')).toMatch(/09:00 UTC$/);
  });

  it('adds the viewer’s own time in brackets when their clock differs', () => {
    expect(formatScheduled(AT, 'Asia/Kolkata', null, 'Europe/London')).toContain('(10:00 your time)');
  });

  it('shows a dash when there is no time', () => {
    expect(formatScheduled(null, 'Asia/Kolkata', null)).toBe('—');
  });
});
