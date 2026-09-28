import { describe, it, expect } from 'vitest';
import { MAX_POLL_DELAY_MS, POLL_DELAY_MS, nextPollDelay } from '../src/components/pollBackoff';

describe('nextPollDelay', () => {
  it('doubles the wait after a failure, so a struggling server is asked less often', () => {
    expect(nextPollDelay(POLL_DELAY_MS)).toBe(POLL_DELAY_MS * 2);
  });

  it('keeps doubling as failures continue', () => {
    expect(nextPollDelay(nextPollDelay(POLL_DELAY_MS))).toBe(POLL_DELAY_MS * 4);
  });

  it('stops at half a minute, so the page still recovers on its own', () => {
    expect(nextPollDelay(20_000)).toBe(MAX_POLL_DELAY_MS);
  });

  it('stays at the cap once it is there', () => {
    expect(nextPollDelay(MAX_POLL_DELAY_MS)).toBe(MAX_POLL_DELAY_MS);
  });

  it('starts from the normal interval for a delay that makes no sense', () => {
    expect([nextPollDelay(0), nextPollDelay(-1), nextPollDelay(Number.NaN)])
      .toEqual([POLL_DELAY_MS, POLL_DELAY_MS, POLL_DELAY_MS]);
  });

  it('never returns a wait longer than the cap, whatever it is handed', () => {
    expect(nextPollDelay(10 * MAX_POLL_DELAY_MS)).toBe(MAX_POLL_DELAY_MS);
  });
});
