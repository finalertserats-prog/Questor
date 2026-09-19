import { describe, expect, it } from 'vitest';
import { addSourceError, bumpSourceStats, emptyStats, nextRunCursor, parseCursor, parseStats } from '../src/services/catalogRefreshState.js';

describe('refresh cursor', () => {
  it('starts every source from the beginning when nothing is stored', () => {
    expect(parseCursor('{}')).toEqual({
      onet: { offset: 0, done: false },
      esco: { page: 0, pages: 0, done: false },
      escoRoles: { offset: 0, lookups: 0, done: false },
      web: { domainIndex: 0, calls: 0, done: false },
    });
  });

  it('keeps stored progress', () => {
    expect(parseCursor(JSON.stringify({ onet: { offset: 300, done: false } })).onet).toEqual({ offset: 300, done: false });
  });

  it('starts over rather than failing on a corrupt cursor', () => {
    expect(parseCursor('not json').onet.offset).toBe(0);
  });

  it('carries the ESCO positions into the next run, resetting per-run counts', () => {
    const previous = { ...parseCursor('{}'), esco: { page: 8, pages: 8, done: true }, escoRoles: { offset: 40, lookups: 40, done: true }, onet: { offset: 900, done: true } };
    const next = nextRunCursor(previous);
    expect({ esco: next.esco, escoRoles: next.escoRoles, onet: next.onet }).toEqual({
      esco: { page: 8, pages: 0, done: false },
      escoRoles: { offset: 40, lookups: 0, done: false },
      onet: { offset: 0, done: false },
    });
  });
});

describe('refresh stats', () => {
  it('starts every source at zero', () => {
    expect(emptyStats().onet).toEqual({ fetched: 0, matchedExisting: 0, proposed: 0, skipped: 0, errors: [] });
  });

  it('adds to one source without touching the original', () => {
    const before = emptyStats();
    const after = bumpSourceStats(before, 'esco', { fetched: 3, proposed: 1 });
    expect({ before: before.esco.fetched, after: after.esco.fetched, proposed: after.esco.proposed }).toEqual({ before: 0, after: 3, proposed: 1 });
  });

  it('records errors and bounds how many are kept', () => {
    let stats = emptyStats();
    for (let i = 0; i < 30; i += 1) stats = addSourceError(stats, 'web', `problem ${i}`);
    expect(stats.web.errors).toHaveLength(20);
  });

  it('reads stored stats and fills missing sources', () => {
    expect(parseStats(JSON.stringify({ onet: { fetched: 5, matchedExisting: 1, proposed: 2, skipped: 2, errors: ['x'] } })).esco.fetched).toBe(0);
  });
});
