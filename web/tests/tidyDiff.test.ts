import { describe, expect, it } from 'vitest';
import { MAX_DIFF_WORDS, tidyDiff } from '../src/components/drafts/tidyDiff';

/**
 * The before-and-after a person approves a rewrite of their own words from.
 * Every word they wrote has to still be findable in the "before" column, and
 * every word the model added has to be marked in the "after" one.
 */

const text = (segments: readonly { kind: string; text: string }[]) => segments.map((s) => s.text).join('');

describe('tidying a sentence', () => {
  const before = 'he cant do mornings before 11';
  const after = 'He is not available before 11:00.';

  it('keeps both versions whole', () => {
    const diff = tidyDiff(before, after);
    expect(text(diff.before)).toBe(before);
    expect(text(diff.after)).toBe(after);
  });

  it('marks what went and what arrived', () => {
    const diff = tidyDiff(before, after);
    expect(diff.before.some((s) => s.kind === 'removed')).toBe(true);
    expect(diff.after.some((s) => s.kind === 'added')).toBe(true);
  });

  it('leaves the words they kept unmarked', () => {
    const diff = tidyDiff(before, after);
    expect(diff.before.some((s) => s.kind === 'same' && s.text.includes('before'))).toBe(true);
  });
});

describe('a tidy that changed nothing', () => {
  it('says so rather than marking the whole thing', () => {
    const diff = tidyDiff('Already a clean sentence.', 'Already a clean sentence.');
    expect(diff.unchanged).toBe(true);
    expect(diff.before.every((s) => s.kind === 'same')).toBe(true);
  });
});

describe('two texts too long to compare word by word', () => {
  it('shows both whole and says it could not mark them', () => {
    const long = 'word '.repeat(MAX_DIFF_WORDS + 10);
    const diff = tidyDiff(long, `${long}more`);
    expect(diff.detailed).toBe(false);
    expect(text(diff.before)).toBe(long);
  });
});
