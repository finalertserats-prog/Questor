import { describe, it, expect } from 'vitest';
import { formatPercent, formatScore, formatScoreOutOf100, hasScore, roundScore } from '../src/components/scoreFormat';

describe('formatScore', () => {
  it('rounds a real score to a whole number', () => {
    expect(formatScore(72.4)).toBe('72');
  });

  it('keeps zero, which is a score and not a missing one', () => {
    expect(formatScore(0)).toBe('0');
  });

  // The defect: older stored fit results have no overall, so Math.round(undefined)
  // reached the page as the literal "NaN".
  it('shows a dash when the score is missing', () => {
    expect(formatScore(undefined)).toBe('—');
  });

  it('shows a dash when the score is null', () => {
    expect(formatScore(null)).toBe('—');
  });

  it('shows a dash for NaN rather than printing it', () => {
    expect(formatScore(Number.NaN)).toBe('—');
  });

  it('shows a dash for an infinite value', () => {
    expect(formatScore(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('shows a dash for a score that arrived as a string', () => {
    expect(formatScore('72')).toBe('—');
  });
});

describe('formatScoreOutOf100', () => {
  it('names the scale a real score is on', () => {
    expect(formatScoreOutOf100(72.4)).toBe('72/100');
  });

  it('never says NaN out of a hundred', () => {
    expect(formatScoreOutOf100(undefined)).toBe('—');
  });
});

describe('hasScore', () => {
  it('is true for a real number', () => {
    expect(hasScore(0)).toBe(true);
  });

  it('is false for anything that is not one', () => {
    expect([undefined, null, Number.NaN, '5', {}].map(hasScore)).toEqual([false, false, false, false, false]);
  });
});

describe('roundScore', () => {
  it('rounds a real score for the arithmetic a meter needs', () => {
    expect(roundScore(72.6)).toBe(73);
  });

  it('returns null rather than NaN when there is no score', () => {
    expect(roundScore(undefined)).toBe(null);
  });
});

describe('formatPercent', () => {
  it('shows a fraction as a whole percentage', () => {
    expect(formatPercent(0.734)).toBe('73%');
  });

  it('keeps a real zero, which means none of the answers had evidence', () => {
    expect(formatPercent(0)).toBe('0%');
  });

  // Not the same statement as 0%: one is a measurement, the other is no data.
  it('shows a dash when the figure has not arrived', () => {
    expect(formatPercent(null)).toBe('—');
  });

  it('shows a dash when the figure is missing entirely', () => {
    expect(formatPercent(undefined)).toBe('—');
  });
});
