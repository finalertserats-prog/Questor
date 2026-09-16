import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime } from '../src/components/dateFormat';

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
