import { describe, expect, it } from 'vitest';
import { budgetRoom, msUntilNextUtcDay, utcDay } from '../../src/library/budget.js';

/** Budget arithmetic: calls per UTC day, tokens over a rolling 30 days. */

describe('budgetRoom', () => {
  it('allows a batch with room under both caps', () => {
    expect(budgetRoom({ callsUsedToday: 10, dailyCap: 3000, tokens30d: 1000, monthlyCap: 100_000, callsNeeded: 3 }).ok).toBe(true);
  });

  it('refuses when the day\'s calls would pass the cap', () => {
    expect(budgetRoom({ callsUsedToday: 2998, dailyCap: 3000, tokens30d: 0, monthlyCap: 100_000, callsNeeded: 3 }).reason).toBe('daily_cap');
  });

  it('refuses when the rolling token cap is reached', () => {
    expect(budgetRoom({ callsUsedToday: 0, dailyCap: 3000, tokens30d: 100_000, monthlyCap: 100_000, callsNeeded: 3 }).reason).toBe('monthly_cap');
  });

  it('keeps room under the token cap for the work about to start', () => {
    expect(budgetRoom({ callsUsedToday: 0, dailyCap: 3000, tokens30d: 90_000, monthlyCap: 100_000, callsNeeded: 3, tokensNeeded: 20_000 }).reason).toBe('monthly_cap');
  });

  it('allows exactly filling the day', () => {
    expect(budgetRoom({ callsUsedToday: 2997, dailyCap: 3000, tokens30d: 0, monthlyCap: 100_000, callsNeeded: 3 }).ok).toBe(true);
  });
});

describe('utcDay', () => {
  it('formats the UTC date, not the local one', () => {
    expect(utcDay(new Date('2026-09-20T23:30:00Z'))).toBe('2026-09-20');
  });
});

describe('msUntilNextUtcDay', () => {
  it('counts to the next UTC midnight', () => {
    expect(msUntilNextUtcDay(new Date('2026-09-20T23:00:00Z'))).toBe(60 * 60_000);
  });
});
