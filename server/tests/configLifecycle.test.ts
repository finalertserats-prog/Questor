import { describe, it, expect } from 'vitest';
import { parseDurationMsSetting, parseRateLimitStore } from '../src/config.js';

/**
 * The drain window and the rate-limit store are read once at startup. A typo in
 * either must stop the process with the variable named, not quietly pick a
 * value: a drain of NaN milliseconds ends every interview on the next deploy,
 * and an unknown store name falling back to memory is the per-process limit
 * this setting exists to replace.
 */

describe('reading a duration setting', () => {
  it('uses the default when the variable is unset', () => {
    expect(parseDurationMsSetting('SHUTDOWN_DRAIN_MS', undefined, 1_200_000)).toBe(1_200_000);
  });

  it('accepts a whole number of milliseconds', () => {
    expect(parseDurationMsSetting('SHUTDOWN_DRAIN_MS', ' 60000 ', 1)).toBe(60_000);
  });

  it('accepts zero, which means do not wait', () => {
    expect(parseDurationMsSetting('SHUTDOWN_DRAIN_MS', '0', 1)).toBe(0);
  });

  it('refuses an empty value rather than draining for no time at all', () => {
    expect(() => parseDurationMsSetting('SHUTDOWN_DRAIN_MS', '', 1)).toThrow(/SHUTDOWN_DRAIN_MS/);
  });

  it('refuses a unit suffix instead of truncating it', () => {
    expect(() => parseDurationMsSetting('SHUTDOWN_DRAIN_MS', '20m', 1)).toThrow(/SHUTDOWN_DRAIN_MS/);
  });

  it('refuses a negative duration', () => {
    expect(() => parseDurationMsSetting('SHUTDOWN_DRAIN_MS', '-5', 1)).toThrow(/SHUTDOWN_DRAIN_MS/);
  });
});

describe('choosing the rate-limit store', () => {
  it('defaults to the shared database store in production', () => {
    expect(parseRateLimitStore(undefined, 'production')).toBe('database');
  });

  it('defaults to process memory under test', () => {
    expect(parseRateLimitStore(undefined, 'test')).toBe('memory');
  });

  it('honours an explicit choice', () => {
    expect(parseRateLimitStore('memory', 'production')).toBe('memory');
  });

  it('refuses a store it does not know', () => {
    expect(() => parseRateLimitStore('redis', 'production')).toThrow(/RATE_LIMIT_STORE/);
  });
});
