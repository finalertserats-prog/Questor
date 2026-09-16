import { describe, it, expect } from 'vitest';
import { parsePortSetting } from '../src/config.js';

/**
 * Port settings were `parseInt(env('PORT', '4000'), 10)` with no validation.
 *
 * PORT="" gives NaN, and `listen(NaN)` does not fail — Node binds an
 * ephemeral port instead. The server came up healthy, logged that it was
 * running, and was unreachable behind the reverse proxy: a deploy that looks
 * successful and serves nobody. SMTP_PORT had the same shape, where the failure
 * is a mail connection to a port nobody is listening on.
 */

describe('reading a port setting', () => {
  it('accepts a plain port number', () => {
    expect(parsePortSetting('PORT', '4000')).toBe(4000);
  });

  it('accepts surrounding whitespace, which a .env file makes easy to leave', () => {
    expect(parsePortSetting('PORT', ' 4000 ')).toBe(4000);
  });

  it('refuses an empty value rather than binding a random port', () => {
    expect(() => parsePortSetting('PORT', '')).toThrow();
  });

  it('names the variable so the deploy can be fixed without a bisect', () => {
    expect(() => parsePortSetting('SMTP_PORT', '')).toThrow(/SMTP_PORT/);
  });

  it('refuses a value that is not a number', () => {
    expect(() => parsePortSetting('PORT', 'eighty')).toThrow(/PORT/);
  });

  it('refuses a port above the valid range', () => {
    expect(() => parsePortSetting('PORT', '70000')).toThrow(/PORT/);
  });

  it('refuses port zero, which also means "any free port"', () => {
    expect(() => parsePortSetting('PORT', '0')).toThrow(/PORT/);
  });

  it('refuses a fractional port rather than silently truncating it', () => {
    expect(() => parsePortSetting('PORT', '80.5')).toThrow(/PORT/);
  });
});
