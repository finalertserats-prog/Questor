import { describe, expect, it } from 'vitest';
import { parseLocalLlmSettings, parseLocalLlmUrlSetting, DEFAULT_LOCAL_LLM_URL } from '../src/config.js';

/**
 * A mistyped LOCAL_LLM_URL must stop the process at start, not fail every
 * fallback call in the middle of an outage, which is the one moment it matters.
 */

describe('parseLocalLlmUrlSetting', () => {
  it('defaults to Ollama on loopback', () => {
    expect(parseLocalLlmUrlSetting(undefined)).toBe(DEFAULT_LOCAL_LLM_URL);
  });

  it('drops a trailing slash', () => {
    expect(parseLocalLlmUrlSetting('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
  });

  it('rejects something that is not a URL', () => {
    expect(() => parseLocalLlmUrlSetting('localhost:11434')).toThrow(/LOCAL_LLM_URL/);
  });

  it('rejects a non-http scheme', () => {
    expect(() => parseLocalLlmUrlSetting('file:///etc/passwd')).toThrow(/LOCAL_LLM_URL/);
  });

  it('rejects credentials in the URL', () => {
    expect(() => parseLocalLlmUrlSetting('http://user:pw@127.0.0.1:11434')).toThrow(/LOCAL_LLM_URL/);
  });
});

describe('parseLocalLlmSettings', () => {
  const from = (env: Record<string, string>) => (key: string) => env[key];

  it('is off by default', () => {
    expect(parseLocalLlmSettings(from({})).enabled).toBe(false);
  });

  it('ignores a mistyped local setting while the fallback is off, so the server still starts', () => {
    expect(() => parseLocalLlmSettings(from({ LOCAL_LLM_URL: 'localhost:11434', LOCAL_LLM_TIMEOUT_MS: '12s' }))).not.toThrow();
  });

  it('refuses a mistyped local setting once the fallback is on', () => {
    expect(() => parseLocalLlmSettings(from({ LOCAL_LLM_ENABLED: 'true', LOCAL_LLM_TIMEOUT_MS: '12s' }))).toThrow(/LOCAL_LLM_TIMEOUT_MS/);
  });

  it('reads the chosen model when on', () => {
    expect(parseLocalLlmSettings(from({ LOCAL_LLM_ENABLED: 'true', LOCAL_LLM_MODEL: 'phi4-mini' })).model).toBe('phi4-mini');
  });

  it('defaults to llama3.2:3b', () => {
    expect(parseLocalLlmSettings(from({ LOCAL_LLM_ENABLED: 'true' })).model).toBe('llama3.2:3b');
  });
});
