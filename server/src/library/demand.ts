import { prisma } from '../db.js';
import { slugifyCatalogName } from '../domain/catalogText.js';
import { roleSuccessProfileSchema } from '../domain/profileSchema.js';
import type { BandId } from '../engines/experienceBands.js';
import { BANDS } from '../engines/experienceBands.js';
import type { PoolCompetency } from './generator.js';
import { BASE_DEPTH_IN_USE, BASE_DEPTH_LONG_TAIL, HISTORY_DAYS } from './poolTargets.js';
import type { PoolKey } from './types.js';

/**
 * The demand queue: which pools the worker should fill next.
 *
 *   0  roles with a scheduled interview and no live entries (urgent)
 *   1  roles an organisation created (catalog roles with a creating tenant)
 *   2  the top 50 roles by interview volume over the last 60 days
 *   3  the long tail, at base depth 6
 *
 * Within a priority, the thinnest pool (largest deficit against its target)
 * goes first. Only pools below target are returned.
 */

export const TOP_ROLES = 50;
/** Entries the pool needs but has not queued for generation; the worker fills a batch at a time. */
export const QUEUED_STATUSES = ['live', 'probational', 'draft'] as const;

export type DemandPriority = 0 | 1 | 2 | 3;

export interface DemandPool extends PoolKey {
  readonly priority: DemandPriority;
  readonly roleId: string;
  readonly roleTitle: string;
  readonly familyName: string;
  readonly competency: PoolCompetency;
  readonly jdText: string;
  readonly target: number;
  /** live + probational + drafts waiting for the owner. */
  readonly filled: number;
  readonly live: number;
  readonly formCounts: Readonly<Record<string, number>>;
}

const BAND_IDS = new Set<string>(BANDS.map((b) => b.id));

function isBandId(value: string): value is BandId {
  return BAND_IDS.has(value);
}

function competenciesOf(profileJson: string): PoolCompetency[] {
  try {
    const parsed = roleSuccessProfileSchema.safeParse(JSON.parse(profileJson));
    if (!parsed.success) return [];
    return parsed.data.competencies
      .filter((c) => c.classification !== 'non_scoring')
      .map((c) => ({ name: c.name, definition: c.definition ?? '', indicators: c.indicators ?? [], category: c.category }));
  } catch {
    return [];
  }
}

interface RoleRow {
  readonly id: string;
  readonly title: string;
  readonly experienceBand: string | null;
  /** Shared text for a global pool: the catalog JD draft for the band, else the catalog summary. Never the organisation's own JD. */
  readonly sharedJdText: string;
  readonly catalogRole: { readonly id: string; readonly title: string; readonly summary: string; readonly createdByTenantId: string | null; readonly family: { readonly name: string } | null } | null;
  readonly scorecards: readonly { readonly profileJson: string }[];
  readonly interviews60d: number;
  readonly scheduled: number;
}

async function loadRoles(now: Date): Promise<RoleRow[]> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60_000);
  const rows = await prisma.role.findMany({
    where: { catalogRoleId: { not: null }, experienceBand: { not: null }, status: { not: 'archived' } },
    select: {
      id: true, title: true, experienceBand: true,
      catalogRole: { select: { id: true, title: true, summary: true, createdByTenantId: true, family: { select: { name: true } } } },
      scorecards: { where: { status: 'approved' }, orderBy: { version: 'desc' }, take: 1, select: { profileJson: true } },
      _count: {
        select: {
          interviews: { where: { createdAt: { gte: since } } },
        },
      },
    },
  });
  const scheduled = await prisma.interviewSession.groupBy({
    by: ['roleId'],
    where: { OR: [{ scheduledAt: { gte: now } }, { state: { in: ['PROVISIONED', 'INVITED'] } }] },
    _count: { _all: true },
  });
  const scheduledByRole = new Map(scheduled.map((s) => [s.roleId, s._count._all]));
  // A global pool is written from text every organisation already shares: the
  // catalog's own JD draft for that role and band (or its summary). An
  // organisation's job description names its products, teams and customers,
  // and a global entry is selectable by every other organisation.
  const drafts = await prisma.catalogJdDraft.findMany({
    where: { status: 'ready', catalogRoleId: { in: [...new Set(rows.map((r) => r.catalogRole?.id).filter((id): id is string => !!id))] } },
    select: { catalogRoleId: true, experienceBand: true, text: true },
    orderBy: { updatedAt: 'desc' },
  });
  const draftText = new Map<string, string>();
  for (const draft of drafts) {
    const key = `${draft.catalogRoleId}|${draft.experienceBand}`;
    if (!draftText.has(key)) draftText.set(key, draft.text);
  }
  return rows.map((r) => ({
    id: r.id, title: r.title, experienceBand: r.experienceBand, catalogRole: r.catalogRole, scorecards: r.scorecards,
    sharedJdText: (r.catalogRole ? draftText.get(`${r.catalogRole.id}|${r.experienceBand ?? ''}`) : undefined) ?? r.catalogRole?.summary ?? '',
    interviews60d: r._count.interviews, scheduled: scheduledByRole.get(r.id) ?? 0,
  }));
}

interface PoolCounts {
  readonly live: number;
  readonly filled: number;
  readonly formCounts: Record<string, number>;
}

async function loadPoolCounts(): Promise<Map<string, PoolCounts>> {
  const rows = await prisma.libraryEntry.groupBy({
    by: ['roleSlug', 'competencyKey', 'band', 'status', 'form', 'gateOutcome'],
    where: { scope: 'global', status: { in: [...QUEUED_STATUSES] } },
    _count: { _all: true },
  });
  const counts = new Map<string, { live: number; filled: number; formCounts: Record<string, number> }>();
  for (const row of rows) {
    const key = `${row.roleSlug}|${row.competencyKey}|${row.band}`;
    const current = counts.get(key) ?? { live: 0, filled: 0, formCounts: {} };
    // A draft counts only while it waits for the owner; a failed draft is not a draft.
    const queued = row.status !== 'draft' || row.gateOutcome === 'unsure';
    const n = row._count._all;
    counts.set(key, {
      live: current.live + (row.status === 'live' ? n : 0),
      filled: current.filled + (queued ? n : 0),
      formCounts: row.status === 'draft' ? current.formCounts : { ...current.formCounts, [row.form]: (current.formCounts[row.form] ?? 0) + n },
    });
  }
  return counts;
}

async function loadTargets(): Promise<Map<string, number>> {
  const rows = await prisma.libraryPoolTarget.findMany({ where: { scope: 'global' }, select: { roleSlug: true, competencyKey: true, band: true, depthTarget: true } });
  return new Map(rows.map((r) => [`${r.roleSlug}|${r.competencyKey}|${r.band}`, r.depthTarget]));
}

export async function loadDemandQueue(now = new Date()): Promise<DemandPool[]> {
  const [roles, counts, targets] = await Promise.all([loadRoles(now), loadPoolCounts(), loadTargets()]);
  const volumeBySlug = new Map<string, number>();
  for (const role of roles) {
    if (!role.catalogRole) continue;
    const slug = slugifyCatalogName(role.catalogRole.title);
    volumeBySlug.set(slug, (volumeBySlug.get(slug) ?? 0) + role.interviews60d);
  }
  const topSlugs = new Set([...volumeBySlug.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, TOP_ROLES).map(([slug]) => slug));

  const pools = new Map<string, DemandPool>();
  for (const role of roles) {
    const profile = role.scorecards[0];
    if (!profile || !role.catalogRole || !role.experienceBand || !isBandId(role.experienceBand)) continue;
    const roleSlug = slugifyCatalogName(role.catalogRole.title);
    const familyName = role.catalogRole.family?.name ?? 'General';
    const familySlug = slugifyCatalogName(familyName) || 'general';
    const inUse = (volumeBySlug.get(roleSlug) ?? 0) > 0;
    for (const competency of competenciesOf(profile.profileJson)) {
      const competencyKey = slugifyCatalogName(competency.name);
      if (!competencyKey) continue;
      const key = `${roleSlug}|${competencyKey}|${role.experienceBand}`;
      const count = counts.get(key) ?? { live: 0, filled: 0, formCounts: {} };
      const target = targets.get(key) ?? (inUse ? BASE_DEPTH_IN_USE : BASE_DEPTH_LONG_TAIL);
      const priority: DemandPriority = role.scheduled > 0 && count.live === 0 ? 0
        : role.catalogRole.createdByTenantId ? 1
          : topSlugs.has(roleSlug) ? 2 : 3;
      const existing = pools.get(key);
      // Several organisations may hire the same catalog role: keep the most urgent view of it.
      if (existing && existing.priority <= priority) continue;
      pools.set(key, {
        scope: 'global', tenantId: null, roleSlug, familySlug, competencyKey, band: role.experienceBand,
        priority, roleId: role.id, roleTitle: role.catalogRole.title, familyName, competency, jdText: role.sharedJdText,
        target, filled: count.filled, live: count.live, formCounts: count.formCounts,
      });
    }
  }
  return [...pools.values()]
    .filter((p) => p.filled < p.target)
    .sort((a, b) => a.priority - b.priority || (b.target - b.filled) - (a.target - a.filled) || a.roleSlug.localeCompare(b.roleSlug));
}
