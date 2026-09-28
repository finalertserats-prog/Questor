import { prisma } from '../db.js';
import { slugifyCatalogName } from '../domain/catalogText.js';
import { DEFAULT_POLICY, TARGET_FORMS, type LibraryForm } from './types.js';

/**
 * How deep a pool must be, from how often the role is interviewed.
 *
 *   depthTarget = max(baseDepth, ceil(expectedInterviewsInWindow × laddersPerInterview × 1.25))
 *
 * The window is the no-repeat window (30 days by default); expected interviews
 * come from the last 60 days of that role across every organisation, or the
 * family average for a role with no history. The 1.25 leaves room for
 * retirements. Base depth is 12 for a role in use and 6 for the long tail.
 */

export const BASE_DEPTH_IN_USE = 12;
export const BASE_DEPTH_LONG_TAIL = 6;
export const HEADROOM = 1.25;
export const HISTORY_DAYS = 60;

export function depthTarget(opts: { readonly expectedInterviewsInWindow: number; readonly inUse: boolean; readonly laddersPerInterview?: number }): number {
  const base = opts.inUse ? BASE_DEPTH_IN_USE : BASE_DEPTH_LONG_TAIL;
  const demand = Math.ceil(opts.expectedInterviewsInWindow * (opts.laddersPerInterview ?? 1) * HEADROOM);
  return Math.max(base, demand);
}

export function expectedInterviewsInWindow(opts: { readonly interviewsLast60Days: number; readonly windowDays: number; readonly familyAverageLast60Days?: number }): number {
  const history = opts.interviewsLast60Days > 0 ? opts.interviewsLast60Days : (opts.familyAverageLast60Days ?? 0);
  return (history * opts.windowDays) / HISTORY_DAYS;
}

/**
 * Spread a pool's depth over the target forms so no form can exceed half the
 * pool and at least three forms are present; the remainder goes to the first
 * forms in the list.
 */
export function formMixTarget(depth: number): Record<string, number> {
  const forms = TARGET_FORMS;
  const share = Math.floor(depth / forms.length);
  const remainder = depth - share * forms.length;
  const cap = Math.max(1, Math.floor(depth / 2));
  const mix: Record<string, number> = {};
  forms.forEach((form, i) => {
    const count = Math.min(cap, share + (i < remainder ? 1 : 0));
    if (count > 0) mix[form] = count;
  });
  return mix;
}

export function formMixSatisfied(counts: Readonly<Record<string, number>>): { readonly ok: boolean; readonly problems: readonly string[] } {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const problems: string[] = [];
  const present = Object.entries(counts).filter(([, n]) => n > 0);
  if (present.length < 3) problems.push('fewer than three forms');
  for (const [form, n] of present) {
    if (total > 0 && n / total > 0.5) problems.push(`${form} over 50%`);
  }
  return { ok: problems.length === 0, problems };
}

export type PoolHealth = 'empty' | 'thin' | 'ready';

export function poolHealth(opts: { readonly live: number; readonly target: number }): PoolHealth {
  if (opts.live <= 0) return 'empty';
  return opts.live >= opts.target ? 'ready' : 'thin';
}

/** Which form a new question should take: the least represented target form. */
export function nextFormsFor(counts: Readonly<Record<string, number>>, wanted: number): LibraryForm[] {
  const ranked = [...TARGET_FORMS].sort((a, b) => (counts[a] ?? 0) - (counts[b] ?? 0));
  return Array.from({ length: wanted }, (_, i) => ranked[i % ranked.length]);
}

// --- Nightly recompute -------------------------------------------------------

interface PoolDemand {
  readonly roleSlug: string;
  readonly familySlug: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly interviewsLast60Days: number;
}

/**
 * Every global pool implied by tenant roles that carry a scorecard, with the
 * role's interviews over the last 60 days across all organisations.
 */
export async function loadPoolDemand(now: Date): Promise<PoolDemand[]> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60_000);
  const roles = await prisma.role.findMany({
    where: { catalogRoleId: { not: null }, experienceBand: { not: null } },
    select: {
      id: true, experienceBand: true,
      catalogRole: { select: { title: true, family: { select: { name: true } } } },
      scorecards: { where: { status: 'approved' }, orderBy: { version: 'desc' }, take: 1, select: { profileJson: true } },
      _count: { select: { interviews: { where: { createdAt: { gte: since } } } } },
    },
  });
  const byPool = new Map<string, PoolDemand>();
  for (const role of roles) {
    const profile = role.scorecards[0];
    if (!profile || !role.catalogRole || !role.experienceBand) continue;
    const roleSlug = slugifyCatalogName(role.catalogRole.title);
    const familySlug = slugifyCatalogName(role.catalogRole.family?.name ?? 'general') || 'general';
    for (const name of competencyNames(profile.profileJson)) {
      const competencyKey = slugifyCatalogName(name);
      if (!competencyKey) continue;
      const key = `${roleSlug}|${competencyKey}|${role.experienceBand}`;
      const current = byPool.get(key);
      byPool.set(key, {
        roleSlug, familySlug, competencyKey, band: role.experienceBand,
        interviewsLast60Days: (current?.interviewsLast60Days ?? 0) + role._count.interviews,
      });
    }
  }
  return [...byPool.values()];
}

function competencyNames(profileJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(profileJson);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { competencies?: unknown }).competencies)) return [];
    return (parsed as { competencies: unknown[] }).competencies
      .map((c) => (c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string' ? (c as { name: string }).name : ''))
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

/** Recompute every global pool's target. Idempotent; meant for a nightly run. */
export async function recomputePoolTargets(now = new Date()): Promise<number> {
  const demand = await loadPoolDemand(now);
  const familyTotals = new Map<string, { sum: number; n: number }>();
  for (const pool of demand) {
    const t = familyTotals.get(pool.familySlug) ?? { sum: 0, n: 0 };
    familyTotals.set(pool.familySlug, { sum: t.sum + pool.interviewsLast60Days, n: t.n + 1 });
  }
  let written = 0;
  for (const pool of demand) {
    const family = familyTotals.get(pool.familySlug);
    const familyAverage = family && family.n > 0 ? family.sum / family.n : 0;
    const expected = expectedInterviewsInWindow({ interviewsLast60Days: pool.interviewsLast60Days, windowDays: DEFAULT_POLICY.noRepeatWindowDays, familyAverageLast60Days: familyAverage });
    const inUse = pool.interviewsLast60Days > 0;
    const depth = depthTarget({ expectedInterviewsInWindow: expected, inUse });
    const data = {
      depthTarget: depth,
      formMixJson: JSON.stringify(formMixTarget(depth)),
      computedFrom: JSON.stringify({ interviewsLast60Days: pool.interviewsLast60Days, familyAverage, windowDays: DEFAULT_POLICY.noRepeatWindowDays, inUse }),
      computedAt: now,
    };
    await prisma.libraryPoolTarget.upsert({
      where: { scope_tenantId_roleSlug_competencyKey_band: { scope: 'global', tenantId: '', roleSlug: pool.roleSlug, competencyKey: pool.competencyKey, band: pool.band } },
      create: { scope: 'global', tenantId: '', roleSlug: pool.roleSlug, competencyKey: pool.competencyKey, band: pool.band, ...data },
      update: data,
    });
    written += 1;
  }
  return written;
}
