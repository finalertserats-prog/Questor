import { describe, it, expect } from 'vitest';
import { recognitionLang } from '../src/speechLang';

/**
 * The browser recognizer used to be told 'en-US' whatever the interview's
 * language, so English speakers in India, the UK or Australia were heard by
 * the US-English model. It now follows the session, then the candidate's own
 * browser locale for the region.
 */
describe('recognitionLang', () => {
  it('uses a session language that already names a region', () => {
    expect(recognitionLang('en-GB', ['en-US'])).toBe('en-GB');
  });

  it("takes the region from the candidate's browser when the session is plain English", () => {
    expect(recognitionLang('en', ['en-IN', 'en', 'hi'])).toBe('en-IN');
  });

  it('skips browser locales in another language', () => {
    expect(recognitionLang('en', ['hi-IN', 'en-AU'])).toBe('en-AU');
  });

  it('falls back to a default region when the browser offers none for that language', () => {
    expect(recognitionLang('es', ['en-GB'])).toBe('es-ES');
  });

  it('is Hindi as spoken in India for a Hindi session', () => {
    expect(recognitionLang('hi', [])).toBe('hi-IN');
  });

  it('is US English when the session language is unknown', () => {
    expect(recognitionLang(undefined, [])).toBe('en-US');
  });

  it('ignores a malformed session language', () => {
    expect(recognitionLang('not a tag!', ['en-GB'])).toBe('en-US');
  });

  it('matches regardless of case', () => {
    expect(recognitionLang('EN', ['en-gb'])).toBe('en-GB');
  });
});
