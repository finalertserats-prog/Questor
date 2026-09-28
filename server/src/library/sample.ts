import { prisma } from '../db.js';
import { utcDay } from './budget.js';

/**
 * The owner's daily sample: `size` entries drawn across strata (pool, band,
 * form, generator version, scope), never purely at random. Strata filled since
 * yesterday weigh more, because that is where a bad batch would be.
 */

export interface SampleCandidate {
  readonly id: string;
  readonly stratumKey: string;
  readonly createdAt: Date;
}

export interface SampleOptions {
  readonly size: number;
  /** Entries created at or after this count as "filled since yesterday". */
  readonly since: Date;
  readonly rng: () => number;
}

/** A small deterministic generator (mulberry32) so tests and replays agree. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Bucket {
  readonly key: string;
  readonly weight: number;
  readonly remaining: string[];
}

function buckets(candidates: readonly SampleCandidate[], since: Date, rng: () => number): Bucket[] {
  const byKey = new Map<string, SampleCandidate[]>();
  for (const c of candidates) byKey.set(c.stratumKey, [...(byKey.get(c.stratumKey) ?? []), c]);
  const freshTotal = Math.max(1, candidates.filter((c) => c.createdAt >= since).length);
  return [...byKey.entries()].map(([key, items]) => {
    const fresh = items.filter((c) => c.createdAt >= since).length;
    // Base weight 1 so a quiet stratum is still seen; up to +4 for the share of
    // everything new since yesterday that landed in this stratum.
    const weight = 1 + 4 * (fresh / freshTotal);
    const ids = items.map((c) => c.id);
    // Fisher–Yates on a copy: which entry within a stratum is drawn is random too.
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    return { key, weight, remaining: ids };
  });
}

export function stratifiedSample(candidates: readonly SampleCandidate[], opts: SampleOptions): string[] {
  const pool = buckets(candidates, opts.since, opts.rng);
  const picked: string[] = [];
  while (picked.length < opts.size) {
    const open = pool.filter((b) => b.remaining.length > 0);
    if (open.length === 0) break;
    const total = open.reduce((sum, b) => sum + b.weight, 0);
    let roll = opts.rng() * total;
    let chosen = open[open.length - 1];
    for (const bucket of open) {
      roll -= bucket.weight;
      if (roll <= 0) {
        chosen = bucket;
        break;
      }
    }
    const next = chosen.remaining.shift();
    if (next) picked.push(next);
  }
  return picked;
}

// --- Persistence -------------------------------------------------------------

/**
 * Today's sample, drawn once and remembered on the entries (`sampledOn`) so a
 * refresh shows the same twenty. Candidates are probational and live entries
 * never sampled before.
 */
export async function todaysSample(size: number, now = new Date()): Promise<string[]> {
  const today = utcDay(now);
  const existing = await prisma.libraryEntry.findMany({ where: { sampledOn: today }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  if (existing.length > 0) return existing.map((e) => e.id);
  const candidates = await prisma.libraryEntry.findMany({
    where: { status: { in: ['probational', 'live'] }, sampledOn: '' },
    select: { id: true, stratumKey: true, createdAt: true },
  });
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const picked = stratifiedSample(candidates, { size, since, rng: Math.random });
  if (picked.length === 0) return [];
  await prisma.libraryEntry.updateMany({ where: { id: { in: picked } }, data: { sampledOn: today } });
  // Returned in the same order a later read gives, so the screen never reorders itself.
  const stored = await prisma.libraryEntry.findMany({ where: { sampledOn: today }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  return stored.map((e) => e.id);
}
