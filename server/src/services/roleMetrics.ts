import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope, roleScope } from './access.js';
import type { AuthClaims } from './auth.js';
import { COMPLETED_STATES } from './dashboardMetrics.js';

/**
 * Role metrics contract:
 * - `applied`: candidates whose `Candidate.roleId` is the role.
 * - `interviewInvited`: distinct candidates with at least one session for the role that has an
 *   invitation or reached a completed state (a completed interview was put to the candidate
 *   however it started); a provisioned session nobody was invited to is not counted. Retakes
 *   count once. So `interviewed` <= `interviewInvited` always.
 * - `interviewed`: distinct candidates with at least one completed-state session for the role.
 * - `awaitingReview`: sessions for the role in `REVIEW_READY`.
 * - `decisions`: decided pipeline rows by APPROVED / REJECTED / WITHDRAWN.
 * - `advanceRate`: APPROVED / (APPROVED + REJECTED), WITHDRAWN excluded; null below `MIN_SAMPLE`.
 * - `medianInviteToCompleteHours`: median completion minus invitation sent/created in the last 90 days; null below `MIN_SAMPLE`.
 * - `lastActivityAt`: latest session or candidate (application) creation time for the role.
 *
 * Row ceilings: roles, the per-(role, candidate) invited/interviewed groups and
 * the turnaround samples are each read up to `rowLimit` rows; reaching any of
 * them sets `truncated`. The per-role groupBys return at most one row per role.
 *
 * Roles come from `roleScope(auth)`. Every candidate-derived count is also
 * restricted through `candidateScope(auth)` so an assigned role never leaks
 * candidates hidden by direct candidate assignment rules.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TURNAROUND_WINDOW_DAYS = 90;
export const ROLE_METRICS_ROW_LIMIT = 20_000;
export const MIN_SAMPLE = 5;
export const ROLE_DECISIONS = ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

type RoleDecision = (typeof ROLE_DECISIONS)[number];

export interface RoleFunnel {
  readonly id: string;
  readonly title: string;
  readonly level: string;
  readonly status: string;
  readonly domain: string | null;
  readonly regionCode: string | null;
  readonly experienceBand: string | null;
  readonly applied: number;
  readonly interviewInvited: number;
  readonly interviewed: number;
  readonly awaitingReview: number;
  readonly decisions: Readonly<Record<RoleDecision, number>>;
  readonly advanceRate: number | null;
  readonly medianInviteToCompleteHours: number | null;
  readonly lastActivityAt: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
}

/** A chart item; level, region, band and creation time tell same-titled roles apart. */
export interface RoleTopItem {
  readonly id: string;
  readonly title: string;
  readonly level: string;
  readonly regionCode: string | null;
  readonly experienceBand: string | null;
  readonly createdAt: string;
  readonly count: number;
}

export interface RoleMetrics {
  readonly generatedAt: string;
  readonly truncated: boolean;
  readonly minSample: number;
  readonly roles: readonly RoleFunnel[];
  readonly kpis: {
    readonly activeRoles: number;
    readonly rolesWithoutCandidates: number;
    readonly rolesWithReviewBacklog: number;
  };
  readonly topByApplied: readonly RoleTopItem[];
  readonly topByInterviewed: readonly RoleTopItem[];
}

export interface RoleMetricsOptions {
  readonly now?: Date;
  /** Test seam for the row ceiling; production uses ROLE_METRICS_ROW_LIMIT. */
  readonly rowLimit?: number;
  /**
   * Leave archived roles out entirely. The dashboard sets it: its charts sit
   * beside "Active roles", and a closed requisition's history should neither
   * top them nor be scanned on every dashboard load.
   */
  readonly activeOnly?: boolean;
}

type CountByRole = ReadonlyMap<string, number>;

function countMap<T extends { roleId: string | null; _count: { _all: number } }>(rows: readonly T[]): CountByRole {
  return new Map(rows.flatMap((r) => (r.roleId ? [[r.roleId, r._count._all] as const] : [])));
}

function median(values: readonly number[]): number | null {
  if (values.length < MIN_SAMPLE) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

function rate(approved: number, rejected: number): number | null {
  const total = approved + rejected;
  return total < MIN_SAMPLE ? null : Math.round((approved / total) * 1000) / 1000;
}

function top(roles: readonly RoleFunnel[], key: 'applied' | 'interviewed'): RoleTopItem[] {
  return [...roles]
    .filter((r) => r[key] > 0)
    .sort((a, b) => b[key] - a[key] || a.title.localeCompare(b.title))
    .slice(0, 10)
    .map((r) => ({ id: r.id, title: r.title, level: r.level, regionCode: r.regionCode, experienceBand: r.experienceBand, createdAt: r.createdAt, count: r[key] }));
}

export async function getRoleMetrics(auth: AuthClaims, options: RoleMetricsOptions = {}): Promise<RoleMetrics> {
  const now = options.now ?? new Date();
  const rowLimit = options.rowLimit ?? ROLE_METRICS_ROW_LIMIT;
  const { tenantId } = auth;
  const [rScope, candScope] = await Promise.all([roleScope(auth), candidateScope(auth)]);
  const candidate = candScope as Prisma.CandidateWhereInput;

  const role: Prisma.RoleWhereInput = options.activeOnly
    ? { AND: [rScope as Prisma.RoleWhereInput, { status: { not: 'archived' } }] }
    : rScope as Prisma.RoleWhereInput;

  const roles = await prisma.role.findMany({
    where: role,
    select: { id: true, title: true, level: true, status: true, updatedAt: true, createdAt: true, regionCode: true, experienceBand: true, catalogRole: { select: { domain: { select: { name: true } } } } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: rowLimit,
  });
  // Filter by the role relation rather than an `in` list of ids: the list can
  // run to thousands of ids, past what SQLite binds in one statement.
  const candidateRoleWhere: Prisma.CandidateWhereInput = { AND: [candidate, { role }] };
  const sessionWhere: Prisma.InterviewSessionWhereInput = { tenantId, role, candidate };
  const pipelineWhere: Prisma.CandidatePipelineWhereInput = { tenantId, role, candidate };
  const turnaroundSince = new Date(now.getTime() - TURNAROUND_WINDOW_DAYS * DAY_MS);

  const [
    appliedRows, invitedRows, interviewedRows, awaitingRows, decisionRows, lastRows, turnaroundRows, lastAppliedRows,
  ] = roles.length === 0 ? [[], [], [], [], [], [], [], []] : await Promise.all([
    prisma.candidate.groupBy({ by: ['roleId'], where: candidateRoleWhere, _count: { _all: true } }),
    prisma.interviewSession.groupBy({
      by: ['roleId', 'candidateId'],
      where: { ...sessionWhere, OR: [{ invitation: { isNot: null } }, { state: { in: [...COMPLETED_STATES] } }] },
      _count: { _all: true },
      // One row per (role, candidate), so bounded like every other row read here.
      orderBy: [{ roleId: 'asc' }, { candidateId: 'asc' }],
      take: rowLimit,
    }),
    prisma.interviewSession.groupBy({
      by: ['roleId', 'candidateId'],
      where: { ...sessionWhere, state: { in: [...COMPLETED_STATES] } },
      _count: { _all: true },
      orderBy: [{ roleId: 'asc' }, { candidateId: 'asc' }],
      take: rowLimit,
    }),
    prisma.interviewSession.groupBy({
      by: ['roleId'],
      where: { ...sessionWhere, state: 'REVIEW_READY' },
      _count: { _all: true },
    }),
    prisma.candidatePipeline.groupBy({
      by: ['roleId', 'decision'],
      where: { ...pipelineWhere, status: 'DECIDED', decision: { in: [...ROLE_DECISIONS] } },
      _count: { _all: true },
    }),
    prisma.interviewSession.groupBy({
      by: ['roleId'],
      where: sessionWhere,
      _max: { createdAt: true },
    }),
    prisma.interviewSession.findMany({
      where: {
        ...sessionWhere,
        state: { in: [...COMPLETED_STATES] },
        completedAt: { gte: turnaroundSince },
        invitation: { isNot: null },
      },
      select: { roleId: true, completedAt: true, invitation: { select: { sentAt: true, createdAt: true } } },
      // Newest first means the ceiling drops old samples rather than a random
      // database subset, matching the dashboard's bounded-series policy.
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: rowLimit,
    }),
    prisma.candidate.groupBy({ by: ['roleId'], where: candidateRoleWhere, _max: { createdAt: true } }),
  ]);

  const applied = countMap(appliedRows);
  const awaiting = countMap(awaitingRows);
  const invited = new Map<string, number>();
  for (const row of invitedRows) invited.set(row.roleId, (invited.get(row.roleId) ?? 0) + 1);
  const interviewed = new Map<string, number>();
  for (const row of interviewedRows) interviewed.set(row.roleId, (interviewed.get(row.roleId) ?? 0) + 1);

  const decisions = new Map<string, Record<RoleDecision, number>>();
  for (const row of decisionRows) {
    if (!row.decision || !(ROLE_DECISIONS as readonly string[]).includes(row.decision)) continue;
    const current = decisions.get(row.roleId) ?? { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 };
    decisions.set(row.roleId, { ...current, [row.decision]: row._count._all });
  }

  const lastActivity = new Map(lastRows.flatMap((r) => (r._max.createdAt ? [[r.roleId, r._max.createdAt] as const] : [])));
  for (const r of lastAppliedRows) {
    const at = r._max.createdAt;
    if (!r.roleId || !at) continue;
    const seen = lastActivity.get(r.roleId);
    if (!seen || at > seen) lastActivity.set(r.roleId, at);
  }
  const turnaround = new Map<string, number[]>();
  for (const row of turnaroundRows) {
    const invitedAt = row.invitation?.sentAt ?? row.invitation?.createdAt;
    if (!invitedAt || !row.completedAt) continue;
    const hours = (row.completedAt.getTime() - invitedAt.getTime()) / HOUR_MS;
    if (hours < 0) continue;
    turnaround.set(row.roleId, [...(turnaround.get(row.roleId) ?? []), hours]);
  }

  const funnels = roles.map((r): RoleFunnel => {
    const d = decisions.get(r.id) ?? { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 };
    return {
      id: r.id,
      title: r.title,
      level: r.level,
      status: r.status,
      domain: r.catalogRole?.domain.name ?? null,
      regionCode: r.regionCode,
      experienceBand: r.experienceBand,
      applied: applied.get(r.id) ?? 0,
      interviewInvited: invited.get(r.id) ?? 0,
      interviewed: interviewed.get(r.id) ?? 0,
      awaitingReview: awaiting.get(r.id) ?? 0,
      decisions: d,
      advanceRate: rate(d.APPROVED, d.REJECTED),
      medianInviteToCompleteHours: median(turnaround.get(r.id) ?? []),
      lastActivityAt: lastActivity.get(r.id)?.toISOString() ?? null,
      updatedAt: r.updatedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    };
  });

  return {
    generatedAt: now.toISOString(),
    truncated: roles.length >= rowLimit || turnaroundRows.length >= rowLimit || invitedRows.length >= rowLimit || interviewedRows.length >= rowLimit,
    minSample: MIN_SAMPLE,
    roles: funnels,
    kpis: {
      activeRoles: funnels.filter((r) => r.status !== 'archived').length,
      rolesWithoutCandidates: funnels.filter((r) => r.status !== 'archived' && r.applied === 0).length,
      rolesWithReviewBacklog: funnels.filter((r) => r.awaitingReview > 0).length,
    },
    topByApplied: top(funnels, 'applied'),
    topByInterviewed: top(funnels, 'interviewed'),
  };
}
