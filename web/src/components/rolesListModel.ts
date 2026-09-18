import { formatHours } from './dashboardModel';

export type RoleStatusFilter = 'all' | 'draft' | 'approved' | 'archived';
export type RoleSortKey = 'title' | 'applied' | 'interviewed' | 'awaitingReview' | 'advanceRate' | 'medianInviteToCompleteHours' | 'lastActivityAt';
export type SortDirection = 'asc' | 'desc';

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
  readonly decisions: Readonly<{ APPROVED: number; REJECTED: number; WITHDRAWN: number }>;
  readonly advanceRate: number | null;
  readonly medianInviteToCompleteHours: number | null;
  readonly lastActivityAt: string | null;
  readonly updatedAt: string;
  readonly createdAt?: string | null;
}

/** A role in a dashboard ranking. The display fields arrive with newer servers. */
export interface TopRole {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly level?: string | null;
  readonly regionCode?: string | null;
  readonly experienceBand?: string | null;
  readonly createdAt?: string | null;
}

export interface RoleMetricsPayload {
  readonly generatedAt: string;
  readonly truncated: boolean;
  readonly minSample: number;
  readonly roles: readonly RoleFunnel[];
  readonly kpis: {
    readonly activeRoles: number;
    readonly rolesWithoutCandidates: number;
    readonly rolesWithReviewBacklog: number;
  };
  readonly topByApplied: readonly TopRole[];
  readonly topByInterviewed: readonly TopRole[];
}

export function filterRoles(
  roles: readonly RoleFunnel[],
  options: { readonly query?: string; readonly status?: RoleStatusFilter; readonly domain?: string },
): RoleFunnel[] {
  const status = options.status ?? 'all';
  const q = (options.query ?? '').trim().toLowerCase();
  return roles.filter((role) => {
    const statusMatches = status === 'all' ? role.status !== 'archived' : role.status === status;
    if (!statusMatches) return false;
    if (options.domain && role.domain !== options.domain) return false;
    if (!q) return true;
    return role.title.toLowerCase().includes(q) || role.level.toLowerCase().includes(q);
  });
}

function sortableValue(role: RoleFunnel, key: RoleSortKey): string | number | null {
  switch (key) {
    case 'title': return role.title.toLowerCase();
    case 'applied': return role.applied;
    case 'interviewed': return role.interviewed;
    case 'awaitingReview': return role.awaitingReview;
    case 'advanceRate': return role.advanceRate;
    case 'medianInviteToCompleteHours': return role.medianInviteToCompleteHours;
    case 'lastActivityAt': return role.lastActivityAt ? Date.parse(role.lastActivityAt) : null;
  }
}

export function sortRoles(roles: readonly RoleFunnel[], key: RoleSortKey, direction: SortDirection): RoleFunnel[] {
  const sign = direction === 'asc' ? 1 : -1;
  return roles
    .map((role, index) => ({ role, index }))
    .sort((a, b) => {
      const av = sortableValue(a.role, key);
      const bv = sortableValue(b.role, key);
      // Unknown values are less useful than any real measurement; keep them at
      // the foot in both sort directions so a "best" sort never starts with gaps.
      if (av === null && bv === null) return a.index - b.index;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av < bv) return -1 * sign;
      if (av > bv) return 1 * sign;
      return a.index - b.index;
    })
    .map((entry) => entry.role);
}

export function formatAdvanceRate(rate: number | null): string {
  return rate === null ? 'Too few to rate' : `${Math.round(rate * 100)}%`;
}

export function formatTurnaround(hours: number | null): string {
  return hours === null ? 'Too few to rate' : formatHours(hours);
}

export function domainsFromRoles(roles: readonly RoleFunnel[]): readonly string[] {
  return [...new Set(roles.flatMap((r) => (r.domain ? [r.domain] : [])))].sort((a, b) => a.localeCompare(b));
}
