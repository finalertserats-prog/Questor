import { describe, expect, it } from 'vitest';
import { buildLadder, type SelectableEntry } from '../../src/library/select.js';
import { seededRandom } from '../../src/library/sample.js';

/** A ladder per competency: two or three live entries spanning difficulty, varied in form, least recently asked first. */

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

function entry(id: string, difficultyTag: 1 | 2 | 3, form: string, lastAskedAt: Date | null = null, chain: string[] = []): SelectableEntry {
  return { id, difficultyTag, form, lastAskedAt, chainIds: [id, ...chain] };
}

const rng = () => seededRandom(7);

describe('buildLadder', () => {
  it('orders the ladder easiest to hardest', () => {
    const ladder = buildLadder([entry('hard', 3, 'star'), entry('easy', 1, 'opinion'), entry('mid', 2, 'tradeoff')], { recentlyUsedIds: new Set(), rng: rng() });
    expect(ladder.map((e) => e.difficultyTag)).toEqual([1, 2, 3]);
  });

  it('returns an empty ladder when fewer than two entries are usable', () => {
    expect(buildLadder([entry('only', 2, 'star')], { recentlyUsedIds: new Set(), rng: rng() })).toEqual([]);
  });

  it('accepts a ladder of two when only two difficulties exist', () => {
    expect(buildLadder([entry('a', 1, 'star'), entry('b', 3, 'opinion')], { recentlyUsedIds: new Set(), rng: rng() }).length).toBe(2);
  });

  it('never repeats an entry asked for this role in the window', () => {
    const ladder = buildLadder([entry('used', 1, 'star'), entry('a', 1, 'opinion'), entry('b', 2, 'tradeoff'), entry('c', 3, 'walkthrough')], { recentlyUsedIds: new Set(['used']), rng: rng() });
    expect(ladder.map((e) => e.id)).not.toContain('used');
  });

  it('treats a superseded ancestor that was asked as a repeat', () => {
    const ladder = buildLadder([entry('new', 1, 'star', null, ['old']), entry('a', 1, 'opinion'), entry('b', 2, 'tradeoff'), entry('c', 3, 'walkthrough')], { recentlyUsedIds: new Set(['old']), rng: rng() });
    expect(ladder.map((e) => e.id)).not.toContain('new');
  });

  it('uses no form twice in one ladder', () => {
    const ladder = buildLadder([entry('a', 1, 'star'), entry('b', 2, 'star'), entry('c', 3, 'star'), entry('d', 2, 'opinion'), entry('e', 3, 'tradeoff')], { recentlyUsedIds: new Set(), rng: rng() });
    expect(new Set(ladder.map((e) => e.form)).size).toBe(ladder.length);
  });

  it('returns an empty ladder when the pool cannot vary its forms', () => {
    expect(buildLadder([entry('a', 1, 'star'), entry('b', 2, 'star'), entry('c', 3, 'star')], { recentlyUsedIds: new Set(), rng: rng() })).toEqual([]);
  });

  it('prefers an entry never asked over one asked recently', () => {
    const ladder = buildLadder([entry('asked', 1, 'star', day(10)), entry('fresh', 1, 'opinion'), entry('b', 2, 'tradeoff'), entry('c', 3, 'walkthrough')], { recentlyUsedIds: new Set(), rng: rng() });
    expect(ladder[0].id).toBe('fresh');
  });

  it('prefers the least recently asked among asked entries', () => {
    const ladder = buildLadder([entry('recent', 1, 'star', day(18)), entry('older', 1, 'opinion', day(2)), entry('b', 2, 'tradeoff', day(1)), entry('c', 3, 'walkthrough', day(1))], { recentlyUsedIds: new Set(), rng: rng() });
    expect(ladder[0].id).toBe('older');
  });

  it('returns an empty ladder when every usable entry has the same difficulty', () => {
    expect(buildLadder([entry('a', 2, 'star'), entry('b', 2, 'opinion'), entry('c', 2, 'tradeoff')], { recentlyUsedIds: new Set(), rng: rng() })).toEqual([]);
  });

  it('prefers a missing difficulty when filling a gap', () => {
    const ladder = buildLadder([entry('a', 2, 'star'), entry('b', 2, 'opinion'), entry('c', 2, 'tradeoff'), entry('d', 3, 'walkthrough')], { recentlyUsedIds: new Set(), rng: rng() });
    expect(ladder.map((e) => e.id)).toContain('d');
  });

  it('fills a missing difficulty from a neighbouring one', () => {
    const ladder = buildLadder([entry('a', 1, 'star'), entry('b', 1, 'opinion'), entry('c', 3, 'tradeoff')], { recentlyUsedIds: new Set(), rng: rng() });
    expect(ladder.length).toBe(3);
  });
});
