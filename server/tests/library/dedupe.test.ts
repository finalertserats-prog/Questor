import { describe, expect, it } from 'vitest';
import { checkDuplicate, dedupeWithinBatch, jaccard, LexicalShingleBackend, normaliseTokens, shingles } from '../../src/library/dedupe.js';

/** Lexical near-duplicate detection: token shingles and Jaccard, no native code. */

const backend = new LexicalShingleBackend();
const thresholds = { near: 0.5, duplicate: 0.8 };

describe('normaliseTokens', () => {
  it('lowercases, strips punctuation and drops stop words', () => {
    expect(normaliseTokens('Tell me about a time you led the migration!')).toEqual(['tell', 'time', 'led', 'migration']);
  });
});

describe('shingles', () => {
  it('builds overlapping n-grams', () => {
    expect([...shingles(['a', 'b', 'c', 'd'], 3)]).toEqual(['a b c', 'b c d']);
  });

  it('falls back to single tokens when the text is shorter than n', () => {
    expect([...shingles(['a', 'b'], 3)]).toEqual(['a', 'b']);
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets', () => {
    expect(jaccard(new Set(['x', 'y']), new Set(['y', 'x']))).toBe(1);
  });

  it('is 0 for disjoint sets', () => {
    expect(jaccard(new Set(['x']), new Set(['y']))).toBe(0);
  });
});

describe('checkDuplicate', () => {
  it('flags a reworded copy as a duplicate', async () => {
    const text = 'Walk me through how you migrated the billing service to the new payments provider without downtime.';
    const verdict = await checkDuplicate(text, [{ id: 'e1', text: 'Walk me through how you migrated the billing service to the new payments provider without any downtime.' }], thresholds, backend);
    expect(verdict.kind).toBe('duplicate');
  });

  it('flags a question sharing most of its wording as near', async () => {
    const text = 'Walk me through how you migrated the billing service to a new provider and what broke on the way.';
    const verdict = await checkDuplicate(text, [{ id: 'e1', text: 'Walk me through how you migrated the billing service to a new provider and what you would change.' }], thresholds, backend);
    expect(verdict.kind).toBe('near');
  });

  it('passes an unrelated question', async () => {
    const verdict = await checkDuplicate('What is overrated about feature flags in a payments team?', [{ id: 'e1', text: 'Tell me about a time you pushed back on a deadline for a data migration.' }], thresholds, backend);
    expect(verdict.kind).toBe('none');
  });

  it('names the closest match', async () => {
    const verdict = await checkDuplicate('How did you roll back the failed deploy of the ledger service?', [
      { id: 'far', text: 'What would you do differently on your last hiring decision?' },
      { id: 'close', text: 'How did you roll back the failed deploy of the ledger service last year?' },
    ], thresholds, backend);
    expect(verdict.matchId).toBe('close');
  });
});

describe('dedupeWithinBatch', () => {
  it('drops the later of two near-identical questions in one batch', async () => {
    const dropped = await dedupeWithinBatch([
      'Walk me through how you migrated the billing service to the new payments provider without downtime.',
      'What is overrated about feature flags in a payments team?',
      'Walk me through how you migrated the billing service to the new payments provider without any downtime.',
    ], thresholds, backend);
    expect([...dropped]).toEqual([2]);
  });
});
