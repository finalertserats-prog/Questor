import { describe, it, expect } from 'vitest';
import { comparableFitScore } from '../src/domain/fitVocabulary.js';

/**
 * Nothing is not something.
 *
 * Two halves of one failure, and they compound. A scanned CV — a photograph of
 * a document, which is what a phone camera and most older HR systems produce —
 * has no text layer at all. The extractor returned an empty string for it
 * without anyone being told: no page failed, so the "please upload a text-based
 * PDF" message that exists for exactly this could never fire.
 *
 * That empty string was then scored. A role with no must-haves gives an empty
 * CV 55 out of 100, and `comparableFitScore` handed that 55 to every ranking
 * and comparison in the product — so a candidate whose CV we could not read at
 * all sat in a sorted list above a real one at 52. The band said
 * "Not enough on the CV to say" and the number said 55, and it is the number
 * that gets sorted.
 *
 * The extraction half is in cvScannedPdf.test.ts; this is the scoring half.
 */

const fit = (over: Record<string, unknown> = {}) => ({
  overall: 55, confidence: 0.2, components: [], missing: [], probes: [], excludedSignals: [],
  band: 'partial_match' as const, coverage: 0.7, ...over,
});

describe('a number a ranking may use', () => {
  it('is the score when the CV was read and measured', () => {
    expect(comparableFitScore(fit())).toBe(55);
  });

  it('is nothing when there was too little on the CV to say', () => {
    // The band already says this. The number did not, and the number is what
    // sorts a list — so the candidate we could not read ranked against the ones
    // we could.
    expect(comparableFitScore(fit({ band: 'not_enough_evidence', coverage: 0.1 }))).toBeNull();
  });

  it('is nothing for a reading against a scorecard nobody approved', () => {
    expect(comparableFitScore(fit({ provisional: true }))).toBeNull();
  });

  it('is nothing when there is no reading at all', () => {
    expect(comparableFitScore(null)).toBeNull();
  });

  it('still gives a number for a limited match, which is a finding and not a silence', () => {
    // "The CV evidences little of what this role asks for" is something the
    // document actually said. Withholding it would hide a real reading.
    expect(comparableFitScore(fit({ band: 'limited_match', overall: 30 }))).toBe(30);
  });

  it('withholds the number on an older reading that carries no band but no coverage either', () => {
    // Rows written before the evidence-backed scorer carry neither. A number
    // whose provenance cannot be established is not one to sort people by.
    expect(comparableFitScore({ overall: 55, coverage: 0.1 })).toBeNull();
  });

  it('keeps the number on an older reading whose coverage is sound', () => {
    expect(comparableFitScore({ overall: 55, coverage: 0.7 })).toBe(55);
  });
});
