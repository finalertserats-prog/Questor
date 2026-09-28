import { describe, expect, it } from 'vitest';
import { seededRandom, stratifiedSample, type SampleCandidate } from '../../src/library/sample.js';

/** The owner's daily sample: spread across strata, leaning to what was filled since yesterday. */

const since = new Date('2026-09-19T00:00:00Z');
const old = new Date('2026-09-01T00:00:00Z');
const fresh = new Date('2026-09-19T12:00:00Z');

function candidates(spec: Record<string, { old: number; fresh: number }>): SampleCandidate[] {
  return Object.entries(spec).flatMap(([stratumKey, counts]) => [
    ...Array.from({ length: counts.old }, (_, i) => ({ id: `${stratumKey}-old-${i}`, stratumKey, createdAt: old })),
    ...Array.from({ length: counts.fresh }, (_, i) => ({ id: `${stratumKey}-fresh-${i}`, stratumKey, createdAt: fresh })),
  ]);
}

describe('stratifiedSample', () => {
  it('returns at most the asked size', () => {
    expect(stratifiedSample(candidates({ a: { old: 30, fresh: 0 }, b: { old: 30, fresh: 0 } }), { size: 20, since, rng: seededRandom(1) }).length).toBe(20);
  });

  it('returns everything when fewer candidates exist than the size', () => {
    expect(stratifiedSample(candidates({ a: { old: 3, fresh: 0 } }), { size: 20, since, rng: seededRandom(1) }).length).toBe(3);
  });

  it('draws from every stratum when the size allows', () => {
    const picked = stratifiedSample(candidates({ a: { old: 50, fresh: 0 }, b: { old: 50, fresh: 0 }, c: { old: 50, fresh: 0 } }), { size: 20, since, rng: seededRandom(2) });
    expect(new Set(picked.map((id) => id.split('-')[0])).size).toBe(3);
  });

  it('leans to the stratum filled since yesterday', () => {
    const picked = stratifiedSample(candidates({ quiet: { old: 100, fresh: 0 }, busy: { old: 0, fresh: 100 } }), { size: 20, since, rng: seededRandom(3) });
    expect(picked.filter((id) => id.startsWith('busy')).length).toBeGreaterThan(10);
  });

  it('never picks the same entry twice', () => {
    const picked = stratifiedSample(candidates({ a: { old: 10, fresh: 10 }, b: { old: 5, fresh: 5 } }), { size: 20, since, rng: seededRandom(4) });
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('is deterministic for a seed', () => {
    const pool = candidates({ a: { old: 20, fresh: 5 }, b: { old: 20, fresh: 5 } });
    expect(stratifiedSample(pool, { size: 10, since, rng: seededRandom(9) })).toEqual(stratifiedSample(pool, { size: 10, since, rng: seededRandom(9) }));
  });
});
