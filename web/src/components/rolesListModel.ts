import { formatHours } from './dashboardModel';

export type RoleStatusFilter = 'all' | 'draft' | 'approved' | 'archived';
export type RoleSortKey = 'title' | 'applied' | 'interviewed' | 'awaitingReview' | 'advanceRate' | 'medianInviteToCompleteHours' | 'lastActivityAt';
export type SortDirection = 'asc' | 'desc';
/** The narrower views the dashboard's role KPIs link to (?filter=…). */
export type RoleMetricFilter = 'no-candidates' | 'awaiting-review';

export const METRIC_FILTER_LABELS: Readonly<Record<RoleMetricFilter, string>> = {
  'no-candidates': 'Roles with no candidates',
  'awaiting-review': 'Roles awaiting review',
};

/** The dashboard filter named by a ?filter= value, or null for anything else. */
export function metricFilterFromParam(value: string | null): RoleMetricFilter | null {
  return value === 'no-candidates' || value === 'awaiting-review' ? value : null;
}

// The same rules the server uses for the two KPIs (rolesWithoutCandidates,
// rolesWithReviewBacklog), so the number on the card and the rows here agree.
const METRIC_MATCHES: Readonly<Record<RoleMetricFilter, (role: RoleFunnel) => boolean>> = {
  'no-candidates': (role) => role.applied === 0,
  'awaiting-review': (role) => role.awaitingReview > 0,
};

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
  options: {
    readonly query?: string;
    readonly status?: RoleStatusFilter;
    readonly domain?: string;
    readonly experienceBand?: string;
    readonly regionCode?: string;
    /** The roles the server search matched (title, JD, scorecard); null or absent is no search. */
    readonly matchingIds?: ReadonlySet<string> | null;
    readonly metric?: RoleMetricFilter | null;
  },
): RoleFunnel[] {
  const status = options.status ?? 'all';
  const q = (options.query ?? '').trim().toLowerCase();
  return roles.filter((role) => {
    // The review backlog KPI counts archived roles too (a review left behind
    // on an archived role is still owed), so that view does not hide them.
    const showsArchived = options.metric === 'awaiting-review';
    const statusMatches = status === 'all' ? showsArchived || role.status !== 'archived' : role.status === status;
    if (!statusMatches) return false;
    if (options.metric && !METRIC_MATCHES[options.metric](role)) return false;
    if (options.domain && role.domain !== options.domain) return false;
    if (options.experienceBand && role.experienceBand !== options.experienceBand) return false;
    if (options.regionCode && role.regionCode !== options.regionCode) return false;
    if (options.matchingIds && !options.matchingIds.has(role.id)) return false;
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

/** The server caps a search at this; a longer pasted URL is cut rather than refused. */
export const MAX_ROLE_SEARCH_LENGTH = 200;

/** The roles page filters, as they sit in the URL (?q=&domain=&band=&region=&status=). */
export interface RoleFilterState {
  readonly q: string;
  /** A catalog domain name: the roles payload carries the name, not the id. */
  readonly domain: string;
  /** An experience band id. */
  readonly band: string;
  /** A region code. */
  readonly region: string;
  readonly status: RoleStatusFilter;
}

export const EMPTY_ROLE_FILTERS: RoleFilterState = { q: '', domain: '', band: '', region: '', status: 'all' };

const STATUS_FILTERS: readonly RoleStatusFilter[] = ['all', 'draft', 'approved', 'archived'];
const FILTER_KEYS = ['q', 'domain', 'band', 'region', 'status'] as const;

export function filtersFromParams(params: URLSearchParams): RoleFilterState {
  const status = params.get('status') ?? 'all';
  return {
    q: (params.get('q') ?? '').slice(0, MAX_ROLE_SEARCH_LENGTH),
    domain: params.get('domain') ?? '',
    band: params.get('band') ?? '',
    region: params.get('region') ?? '',
    status: (STATUS_FILTERS as readonly string[]).includes(status) ? status as RoleStatusFilter : 'all',
  };
}

/** The URL for these filters; keys it does not own (the dashboard's ?filter=) are kept. */
export function filtersToParams(state: RoleFilterState, current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of FILTER_KEYS) next.delete(key);
  const values: Record<(typeof FILTER_KEYS)[number], string> = {
    q: state.q.trim(),
    domain: state.domain,
    band: state.band,
    region: state.region,
    status: state.status === 'all' ? '' : state.status,
  };
  for (const key of FILTER_KEYS) if (values[key]) next.set(key, values[key]);
  return next;
}

export function hasActiveFilters(state: RoleFilterState, metric: RoleMetricFilter | null): boolean {
  return Boolean(state.q.trim() || state.domain || state.band || state.region || state.status !== 'all' || metric);
}

export function formatRoleCount(visible: number, total: number): string {
  const noun = total === 1 ? 'role' : 'roles';
  return visible === total ? `${total} ${noun}` : `${visible} of ${total} ${noun}`;
}

export function roleMetricsPath(query: string): string {
  const q = query.trim();
  return q ? `/roles/metrics?${new URLSearchParams({ q }).toString()}` : '/roles/metrics';
}

/** "Searching…" shows while the typed text waits for the debounce, and while the request runs. */
export function isSearchPending(o: { readonly draft: string; readonly applied: string; readonly loading: boolean }): boolean {
  return o.loading || o.draft.trim() !== o.applied.trim();
}

/** Catalog options plus any value only the roles carry (a retired catalog entry), sorted, once each. */
export function mergeOptionNames(catalog: readonly string[], fromRoles: readonly string[]): readonly string[] {
  return [...new Set([...catalog, ...fromRoles])].sort((a, b) => a.localeCompare(b));
}
