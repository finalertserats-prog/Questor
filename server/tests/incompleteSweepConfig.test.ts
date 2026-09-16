import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../src/logger.js';
import { resolveInactivityMinutes, DEFAULT_INCOMPLETE_AFTER_MINUTES } from '../src/services/incompleteInterviews.js';

/**
 * How long an interview may be quiet before the sweep closes it out.
 *
 * This was `Number(process.env.INCOMPLETE_AFTER_MINUTES ?? 60) * 60_000`.
 * INCOMPLETE_AFTER_MINUTES="" gives 0 and "1h" gives NaN — and NaN loses every
 * comparison, so BOTH of the sweep's cutoff guards fell through and it marked
 * every live interview INCOMPLETE the moment it ran. A typo in a deploy
 * variable would have ended every interview in progress.
 */

afterEach(() => { vi.restoreAllMocks(); });

describe('reading INCOMPLETE_AFTER_MINUTES', () => {
  it('uses the default when the variable is not set', () => {
    expect(resolveInactivityMinutes(undefined)).toBe(DEFAULT_INCOMPLETE_AFTER_MINUTES);
  });

  it('uses the default when the variable is set to an empty string', () => {
    expect(resolveInactivityMinutes('')).toBe(DEFAULT_INCOMPLETE_AFTER_MINUTES);
  });

  it('uses the default when the variable carries a unit suffix', () => {
    // "1h" is the plausible typo: parseInt would read it as 1 MINUTE and end
    // every interview quiet for sixty seconds, which is worse than ignoring it.
    expect(resolveInactivityMinutes('1h')).toBe(DEFAULT_INCOMPLETE_AFTER_MINUTES);
  });

  it('uses the default when the variable is zero or negative', () => {
    expect(resolveInactivityMinutes('0')).toBe(DEFAULT_INCOMPLETE_AFTER_MINUTES);
  });

  it('accepts a plain number of minutes', () => {
    expect(resolveInactivityMinutes('30')).toBe(30);
  });

  it('warns when it ignores a value, so the deploy typo is visible', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    resolveInactivityMinutes('1h');

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the value is usable', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    resolveInactivityMinutes('30');

    expect(warn).not.toHaveBeenCalled();
  });
});
