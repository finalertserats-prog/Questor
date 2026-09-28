import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXCLUDED_SIGNALS, FIT_BANDS, FIT_BAND_LABELS, FIT_BAND_MEANINGS, FIT_CAVEAT, FIT_STRENGTH_LABELS, fitBandOf } from '../src/domain/fitVocabulary.js';
import { VERDICT_LABELS } from '../src/domain/verdict.js';

/**
 * Fit is said one way, on both sides, and never in the words a decision is
 * said in.
 *
 * The browser cannot import from the server workspace, so it carries a copy of
 * this table. A copy that drifts is how one screen ends up calling a CV reading
 * something the engine never produces — so the two are compared as text, the
 * way the candidate comparison's vocabulary already is.
 */

const WEB = join(__dirname, '..', '..', 'web', 'src', 'components', 'fit', 'fitVocabulary.ts');
const SERVER = join(__dirname, '..', 'src', 'domain', 'fitVocabulary.ts');

const web = readFileSync(WEB, 'utf8');
const server = readFileSync(SERVER, 'utf8');

function list(source: string, name: string): string[] {
  // `[^=]*` steps over a type annotation before the assignment, because one of
  // these lists carries its own (`readonly string[]`), brackets and all.
  const body = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function table(source: string, name: string): string[] {
  const body = new RegExp(`${name}[^=]*=\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => `${m[1]}=${m[2]}`).sort();
}

describe('the fit bands', () => {
  it('are the same list on both sides', () => {
    expect(list(web, 'FIT_BANDS')).toEqual(list(server, 'FIT_BANDS'));
    expect(list(server, 'FIT_BANDS')).toEqual([...FIT_BANDS]);
  });

  it('are labelled the same on both sides', () => {
    expect(table(web, 'FIT_BAND_LABELS')).toEqual(table(server, 'FIT_BAND_LABELS'));
  });

  it('mean the same on both sides', () => {
    expect(table(web, 'FIT_BAND_MEANINGS')).toEqual(table(server, 'FIT_BAND_MEANINGS'));
  });

  it('are drawn the same on both sides', () => {
    expect(table(web, 'FIT_BAND_TONE')).toEqual(table(server, 'FIT_BAND_TONE'));
  });

  it('label their strengths the same on both sides', () => {
    expect(table(web, 'FIT_STRENGTH_LABELS')).toEqual(table(server, 'FIT_STRENGTH_LABELS'));
  });
});

describe('what the engine refuses to read', () => {
  it('is the same list on both sides', () => {
    expect(list(web, 'EXCLUDED_SIGNALS')).toEqual(list(server, 'EXCLUDED_SIGNALS'));
    expect(list(server, 'EXCLUDED_SIGNALS')).toEqual([...EXCLUDED_SIGNALS]);
  });

  it('names the proxies as well as the characteristics themselves', () => {
    expect(EXCLUDED_SIGNALS).toEqual(expect.arrayContaining(['graduation year', 'institution or country of education', 'name', 'photograph']));
  });
});

describe('the caveat', () => {
  it('is one string, said identically wherever a fit number is shown', () => {
    expect(web).toContain(FIT_CAVEAT);
  });

  it('says fit is not a decision', () => {
    expect(FIT_CAVEAT).toContain('never a decision about the candidate');
  });

  it('is joined by the rule that a candidate never sees their own fit', () => {
    expect(server).toContain('A candidate is never shown their fit score.');
    expect(web).toContain('A candidate is never shown their fit score.');
  });
});

describe('the one verdict vocabulary', () => {
  const fitWords = [...Object.values(FIT_BAND_LABELS), ...Object.values(FIT_BAND_MEANINGS), ...Object.values(FIT_STRENGTH_LABELS)]
    .join(' ')
    .toLowerCase();

  it('is not borrowed by any fit wording', () => {
    for (const label of Object.values(VERDICT_LABELS)) {
      expect(fitWords, `fit wording used the verdict word "${label}"`).not.toContain(label.toLowerCase());
    }
  });

  it('stays out of the browser copy too', () => {
    const webStrings = [...web.matchAll(/'([^']{4,})'/g)].map((m) => m[1].toLowerCase()).join(' ');
    for (const label of Object.values(VERDICT_LABELS)) {
      expect(webStrings, `the fit panel's vocabulary used "${label}"`).not.toContain(label.toLowerCase());
    }
  });
});

describe('the band a reading falls into', () => {
  it('refuses to call anything a match when the CV barely speaks to the role', () => {
    expect(fitBandOf(92, 0.2, 0)).toBe('not_enough_evidence');
  });

  it('never calls a reading strong while a must-have is unevidenced', () => {
    expect(fitBandOf(92, 0.9, 1)).toBe('partial_match');
  });

  it('calls a well-covered, well-matched CV a strong match', () => {
    expect(fitBandOf(80, 0.8, 0)).toBe('strong_match');
  });
});
