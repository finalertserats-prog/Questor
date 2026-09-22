import { describe, expect, it } from 'vitest';
import { config, parseBooleanSetting, parseCriticProviderSetting } from '../../src/config.js';

/** The library's switches refuse a spelling that could mean either thing. */

describe('parseBooleanSetting', () => {
  it('defaults when unset', () => {
    expect(parseBooleanSetting('LIBRARY_ENABLED', undefined, false)).toBe(false);
  });

  it('reads true', () => {
    expect(parseBooleanSetting('LIBRARY_ENABLED', 'true', false)).toBe(true);
  });

  it('reads off', () => {
    expect(parseBooleanSetting('LIBRARY_ENABLED', 'off', true)).toBe(false);
  });

  it('refuses "yes"', () => {
    expect(() => parseBooleanSetting('LIBRARY_ENABLED', 'yes', false)).toThrow(/LIBRARY_ENABLED/);
  });
});

describe('parseCriticProviderSetting', () => {
  it('defaults to anthropic', () => {
    expect(parseCriticProviderSetting(undefined)).toBe('anthropic');
  });

  it('accepts openai', () => {
    expect(parseCriticProviderSetting('openai')).toBe('openai');
  });

  it('refuses an unknown provider', () => {
    expect(() => parseCriticProviderSetting('gemini')).toThrow(/LIBRARY_CRITIC_PROVIDER/);
  });
});

describe('LIBRARY_DAILY_SAMPLE_SIZE', () => {
  it('defaults to twenty entries a day', () => {
    expect(config.library.dailySampleSize).toBe(20);
  });
});
