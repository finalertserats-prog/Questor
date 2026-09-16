import { describe, expect, it } from 'vitest';
import {
  RED_FLAG_MAX_COUNT,
  RED_FLAG_MAX_LENGTH,
  addRedFlag,
  clampPassThreshold,
  formatPassThreshold,
  redFlagProblem,
  removeRedFlag,
} from '../src/components/scorecardModel';

/**
 * The pass threshold is stored as a whole number of points out of 100 (see
 * server/src/domain/types.ts). HR saw it rendered as "6500%" because the page
 * multiplied it by 100 as if it were a fraction like the weights.
 */
describe('formatPassThreshold', () => {
  it('shows a threshold stored as points out of 100 as that percentage, not a hundred times it', () => {
    expect(formatPassThreshold(65)).toBe('65%');
  });

  it('shows a dash rather than NaN when the threshold is missing', () => {
    expect(formatPassThreshold(undefined)).toBe('—');
  });

  it('rounds a fractional threshold to whole points', () => {
    expect(formatPassThreshold(72.6)).toBe('73%');
  });
});

describe('clampPassThreshold', () => {
  it('keeps a typed threshold inside 0 to 100', () => {
    expect(clampPassThreshold(650)).toBe(100);
  });

  it('refuses a negative threshold', () => {
    expect(clampPassThreshold(-5)).toBe(0);
  });

  it('treats a non-number as zero rather than NaN', () => {
    expect(clampPassThreshold(Number('abc'))).toBe(0);
  });
});

describe('addRedFlag', () => {
  it('appends a trimmed red flag', () => {
    expect(addRedFlag(['Existing'], '  Blames former colleagues  ')).toEqual(['Existing', 'Blames former colleagues']);
  });

  it('ignores an empty entry', () => {
    expect(addRedFlag(['Existing'], '   ')).toEqual(['Existing']);
  });

  it('does not add the same flag twice, whatever the capitals', () => {
    expect(addRedFlag(['Blames former colleagues'], 'blames FORMER colleagues')).toEqual(['Blames former colleagues']);
  });

  it('collapses runs of whitespace inside a flag', () => {
    expect(addRedFlag([], 'Vague   about    dates')).toEqual(['Vague about dates']);
  });

  it('refuses a flag longer than the limit', () => {
    expect(addRedFlag([], 'x'.repeat(RED_FLAG_MAX_LENGTH + 1))).toEqual([]);
  });

  it('refuses a flag once the list is full', () => {
    const full = Array.from({ length: RED_FLAG_MAX_COUNT }, (_, i) => `Flag ${i}`);

    expect(addRedFlag(full, 'One more')).toHaveLength(RED_FLAG_MAX_COUNT);
  });

  it('returns a new array and leaves the original alone', () => {
    const original = ['Existing'];
    addRedFlag(original, 'New');

    expect(original).toEqual(['Existing']);
  });
});

describe('redFlagProblem', () => {
  it('says nothing when the flag can be added', () => {
    expect(redFlagProblem(['Existing'], 'New flag')).toBeNull();
  });

  it('explains a duplicate', () => {
    expect(redFlagProblem(['Existing'], 'existing')).toMatch(/already/i);
  });

  it('explains a full list', () => {
    const full = Array.from({ length: RED_FLAG_MAX_COUNT }, (_, i) => `Flag ${i}`);

    expect(redFlagProblem(full, 'One more')).toMatch(new RegExp(String(RED_FLAG_MAX_COUNT)));
  });

  it('explains an over-long flag', () => {
    expect(redFlagProblem([], 'x'.repeat(RED_FLAG_MAX_LENGTH + 1))).toMatch(new RegExp(String(RED_FLAG_MAX_LENGTH)));
  });
});

describe('removeRedFlag', () => {
  it('removes the flag at the given position', () => {
    expect(removeRedFlag(['A', 'B', 'C'], 1)).toEqual(['A', 'C']);
  });

  it('leaves the list alone for a position that does not exist', () => {
    expect(removeRedFlag(['A', 'B'], 5)).toEqual(['A', 'B']);
  });
});
