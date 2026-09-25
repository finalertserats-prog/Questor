import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEFAULT_RETENTION_DAYS, retentionDays } from '../src/services/dataRights.js';
import { logger } from '../src/logger.js';

/**
 * How long candidate data is kept, read from RETENTION_DEFAULT_DAYS.
 *
 * parseInt reads "2w" as 2, so a typo in a deploy variable used to shorten the
 * window from 180 days to two and purge interviews that were nowhere near the
 * end of their life — silently, because nothing rejected the value. A setting
 * that cannot be read is ignored and said out loud instead.
 */

const original = process.env.RETENTION_DEFAULT_DAYS;

afterEach(() => {
  if (original === undefined) delete process.env.RETENTION_DEFAULT_DAYS;
  else process.env.RETENTION_DEFAULT_DAYS = original;
  vi.restoreAllMocks();
});

const withValue = (value: string | undefined) => {
  if (value === undefined) delete process.env.RETENTION_DEFAULT_DAYS;
  else process.env.RETENTION_DEFAULT_DAYS = value;
  return retentionDays();
};

describe('the retention window', () => {
  it('is 180 days when nothing is configured', () => {
    expect(withValue(undefined)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('takes a whole number of days', () => {
    expect(withValue('365')).toBe(365);
  });

  it('accepts surrounding whitespace', () => {
    expect(withValue(' 90 ')).toBe(90);
  });

  it.each(['2w', '1h', '30d', '90 days', '12.5', '', 'forever'])('keeps the default rather than reading a number out of %j', (value) => {
    expect(withValue(value)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('says so in the log when it ignores a value, so nobody trusts a setting that is not in force', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    withValue('2w');

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the default for zero and negative days, which would purge everything at once', () => {
    expect([withValue('0'), withValue('-30')]).toEqual([DEFAULT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS]);
  });
});
