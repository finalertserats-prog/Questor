import { describe, expect, it } from 'vitest';
import { demoHasEnded, demoHidesNavItem, formatDemoCountdown } from '../src/components/demoModel';

describe('demo model', () => {
  it('formats countdowns as mm:ss', () => {
    expect(formatDemoCountdown(45_000)).toBe('00:45');
    expect(formatDemoCountdown(65_000)).toBe('01:05');
    expect(formatDemoCountdown(-1)).toBe('00:00');
  });

  it('names nav items hidden in a demo tenant', () => {
    expect(demoHidesNavItem('/settings')).toBe(true);
    expect(demoHidesNavItem('/admin/health')).toBe(true);
    expect(demoHidesNavItem('/roles')).toBe(false);
  });

  it('keeps role and candidate setup visible, since showing it is the point of the demo', () => {
    expect([demoHidesNavItem('/roles/new'), demoHidesNavItem('/candidates/new')]).toEqual([false, false]);
  });

  it('knows when a demo has ended', () => {
    const endsAt = '2026-09-18T12:45:00.000Z';
    expect([demoHasEnded(endsAt, Date.parse('2026-09-18T12:44:59.000Z')), demoHasEnded(endsAt, Date.parse(endsAt))]).toEqual([false, true]);
  });
});
