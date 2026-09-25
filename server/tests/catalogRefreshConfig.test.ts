import { describe, expect, it } from 'vitest';
import { parseCommaList, parseFractionSetting, parsePositiveIntSetting, parseTimeoutMsSetting } from '../src/config.js';

/**
 * The catalog refresh reads several caps from the environment. A typo must
 * stop the process at startup rather than silently remove a cap that keeps a
 * monthly job from flooding the owner's review queue or a paid API.
 */
describe('catalog refresh settings', () => {
  it('splits a comma list and drops empty entries', () => {
    expect(parseCommaList(' a@x.test, ,B@x.test ,')).toEqual(['a@x.test', 'B@x.test']);
  });

  it('returns no entries for an empty list', () => {
    expect(parseCommaList('')).toEqual([]);
  });

  it('uses the fallback for an unset whole number', () => {
    expect(parsePositiveIntSetting('CATALOG_REFRESH_MAX_PROPOSALS', undefined, 200)).toBe(200);
  });

  it('reads a whole number', () => {
    expect(parsePositiveIntSetting('CATALOG_REFRESH_MAX_PROPOSALS', ' 50 ', 200)).toBe(50);
  });

  it('refuses a fractional cap and names the variable', () => {
    expect(() => parsePositiveIntSetting('CATALOG_REFRESH_MAX_PROPOSALS', '2.5', 200)).toThrow(/CATALOG_REFRESH_MAX_PROPOSALS/);
  });

  it('refuses a zero cap', () => {
    expect(() => parsePositiveIntSetting('CATALOG_REFRESH_MAX_LLM_CALLS', '0', 150)).toThrow(/CATALOG_REFRESH_MAX_LLM_CALLS/);
  });

  it('uses the fallback for an unset fraction', () => {
    expect(parseFractionSetting('CATALOG_REFRESH_MIN_CONFIDENCE', undefined, 0.5)).toBe(0.5);
  });

  it('reads a fraction between 0 and 1', () => {
    expect(parseFractionSetting('CATALOG_REFRESH_MIN_CONFIDENCE', '0.65', 0.5)).toBe(0.65);
  });

  it('refuses a fraction above 1', () => {
    expect(() => parseFractionSetting('CATALOG_REFRESH_MIN_CONFIDENCE', '65', 0.5)).toThrow(/CATALOG_REFRESH_MIN_CONFIDENCE/);
  });

  it('uses the fallback for an unset timeout', () => {
    expect(parseTimeoutMsSetting('CATALOG_FETCH_TIMEOUT_MS', undefined, 60_000)).toBe(60_000);
  });

  it('refuses a timeout under one second, which would fail every request', () => {
    expect(() => parseTimeoutMsSetting('CATALOG_FETCH_TIMEOUT_MS', '60', 60_000)).toThrow(/CATALOG_FETCH_TIMEOUT_MS/);
  });

  it('reads a timeout of a second or more', () => {
    expect(parseTimeoutMsSetting('CATALOG_RESEARCH_TIMEOUT_MS', '1000', 60_000)).toBe(1000);
  });

  it('refuses a fraction that is not a number', () => {
    expect(() => parseFractionSetting('CATALOG_REFRESH_MIN_CONFIDENCE', 'high', 0.5)).toThrow(/CATALOG_REFRESH_MIN_CONFIDENCE/);
  });
});
