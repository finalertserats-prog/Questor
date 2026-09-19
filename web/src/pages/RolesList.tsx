import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { formatDate } from '../components/dateFormat';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { roleDetailLine, roleDisplayLabels } from '../components/roleLabelModel';
import { PageSkeleton } from '../components/Skeleton';
import { Banner } from '../components/ui';
import { StatusBadge } from '../components/StatusBadge';
import {
  domainsFromRoles,
  EMPTY_ROLE_FILTERS,
  filterRoles,
  filtersFromParams,
  filtersToParams,
  formatAdvanceRate,
  formatRoleCount,
  formatTurnaround,
  hasActiveFilters,
  isSearchPending,
  MAX_ROLE_SEARCH_LENGTH,
  mergeOptionNames,
  METRIC_FILTER_LABELS,
  metricFilterFromParam,
  roleMetricsPath,
  sortRoles,
  type RoleFilterState,
  type RoleFunnel,
  type RoleMetricsPayload,
  type RoleSortKey,
  type RoleStatusFilter,
  type SortDirection,
} from '../components/rolesListModel';

interface CatalogDomain { readonly id: string; readonly name: string }
interface CatalogBand { readonly id: string; readonly display: string }
interface CatalogRegion { readonly code: string; readonly name: string }

/** Long enough that a word is typed before the server is asked. */
const SEARCH_DEBOUNCE_MS = 300;

const COLUMNS: ReadonlyArray<{ key: RoleSortKey; label: string }> = [
  { key: 'title', label: 'Role' },
  { key: 'applied', label: 'Applied' },
  { key: 'interviewed', label: 'Interviewed' },
  { key: 'awaitingReview', label: 'Interviews awaiting review' },
  { key: 'advanceRate', label: 'Advance rate' },
  { key: 'medianInviteToCompleteHours', label: 'Invite → completed (median)' },
  { key: 'lastActivityAt', label: 'Last activity' },
];

function nextDirection(active: boolean, current: SortDirection): SortDirection {
  return active && current === 'asc' ? 'desc' : 'asc';
}

export function RolesList() {
  const [roles, setRoles] = useState<readonly RoleFunnel[]>([]);
  const [sortKey, setSortKey] = useState<RoleSortKey>('title');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  // The dashboard's role KPIs link here with ?filter=no-candidates or
  // ?filter=awaiting-review; the rows are narrowed by the same rule as the count.
  const [params, setParams] = useSearchParams();
  const metric = metricFilterFromParam(params.get('filter'));
  // The URL holds every filter, so a filtered view can be shared and survives a reload.
  const filters = filtersFromParams(params);
  const fieldId = useId();
  // What is typed; it reaches the URL (and the server) once typing pauses.
  const [draft, setDraft] = useState(filters.q);
  const [matchingIds, setMatchingIds] = useState<ReadonlySet<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [catalog, setCatalog] = useState<{ domains: readonly CatalogDomain[]; bands: readonly CatalogBand[]; regions: readonly CatalogRegion[] }>({ domains: [], bands: [], regions: [] });

  const updateFilters = useCallback((change: Partial<RoleFilterState>) => {
    setParams((current) => filtersToParams({ ...filtersFromParams(current), ...change }, current), { replace: true });
  }, [setParams]);

  useEffect(() => {
    if (draft.trim() === filters.q) return undefined;
    const timer = window.setTimeout(() => updateFilters({ q: draft.slice(0, MAX_ROLE_SEARCH_LENGTH) }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, filters.q, updateFilters]);

  // Back and forward move the URL without typing; the box follows it.
  useEffect(() => {
    setDraft((current) => (current.trim() === filters.q ? current : filters.q));
  }, [filters.q]);

  // The search reaches the job description and scorecard, which the list does
  // not carry, so the server answers it; the other filters stay in the browser.
  useEffect(() => {
    if (!filters.q) {
      setMatchingIds(null);
      setSearchError('');
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    api.get<RoleMetricsPayload>(roleMetricsPath(filters.q))
      .then((d) => { if (!cancelled) { setMatchingIds(new Set((d.roles ?? []).map((r) => r.id))); setSearchError(''); } })
      .catch((err: unknown) => { if (!cancelled) setSearchError(err instanceof Error ? err.message : 'The search did not finish.'); })
      .finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
  }, [filters.q]);

  // The filter options are the catalog's. Without it the page still filters,
  // on the values the roles themselves carry.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<readonly CatalogDomain[]>('/catalog/domains'),
      api.get<readonly CatalogBand[]>('/catalog/experience-bands'),
      api.get<readonly CatalogRegion[]>('/catalog/regions'),
    ])
      .then(([domains, bands, regions]) => { if (!cancelled) setCatalog({ domains, bands, regions }); })
      .catch(() => { /* Options fall back to the values on the roles; nothing is lost. */ });
    return () => { cancelled = true; };
  }, []);

  // Metrics are the list's source of truth: the endpoint already scopes roles
  // and candidate counts the same way the sidebar pages do.
  useEffect(() => {
    let cancelled = false;
    api.get<RoleMetricsPayload>('/roles/metrics')
      .then((d) => { if (!cancelled) setRoles(d.roles ?? []); })
      .catch((err: unknown) => {
        if (cancelled) return;
        // An auditor may not read candidate counts; that is a permission, not a fault.
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setError(err instanceof Error ? err.message : 'Could not load roles.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const domainOptions = useMemo(
    () => mergeOptionNames(catalog.domains.map((d) => d.name), domainsFromRoles(roles)),
    [catalog.domains, roles],
  );
  const bandOptions = useMemo(() => {
    const names = new Map(catalog.bands.map((b) => [b.id, b.display]));
    const extra = roles.flatMap((r) => (r.experienceBand && !names.has(r.experienceBand) ? [r.experienceBand] : []));
    return [...catalog.bands.map((b) => ({ value: b.id, label: b.display })), ...[...new Set(extra)].map((id) => ({ value: id, label: id }))];
  }, [catalog.bands, roles]);
  const regionOptions = useMemo(() => {
    const names = new Map(catalog.regions.map((r) => [r.code, r.name]));
    const codes = mergeOptionNames(catalog.regions.map((r) => r.code), roles.flatMap((r) => (r.regionCode ? [r.regionCode] : [])));
    return codes.map((code) => ({ value: code, label: names.get(code) ?? code })).sort((a, b) => a.label.localeCompare(b.label));
  }, [catalog.regions, roles]);
  const labelById = useMemo(() => {
    const labels = roleDisplayLabels(roles);
    return new Map(roles.map((role, index) => [role.id, labels[index]]));
  }, [roles]);
  const { q, domain, band, region, status } = filters;
  const visible = useMemo(
    () => sortRoles(filterRoles(roles, {
      status,
      domain,
      experienceBand: band,
      regionCode: region,
      matchingIds: q ? matchingIds : null,
      metric,
    }), sortKey, direction),
    [roles, q, status, domain, band, region, matchingIds, metric, sortKey, direction],
  );
  const pending = isSearchPending({ draft, applied: q, loading: searching });
  const clearMetric = () => {
    const next = new URLSearchParams(params);
    next.delete('filter');
    setParams(next);
  };
  const clearFilters = () => {
    setDraft('');
    const next = filtersToParams(EMPTY_ROLE_FILTERS, params);
    next.delete('filter');
    setParams(next, { replace: true });
  };

  const setSort = (key: RoleSortKey) => {
    const active = key === sortKey;
    setDirection(nextDirection(active, direction));
    setSortKey(key);
  };

  if (loading) return <PageSkeleton label="Loading roles…" />;
  if (forbidden) {
    return (
      <div>
        <PageHeader icon="role" title="Roles" />
        <Banner kind="info">
          The roles list shows candidate counts, which your role does not include. Ask an admin if you need access.
        </Banner>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        icon="role"
        title="Roles"
        actions={<Link className="btn secondary" to="/roles/new"><Icon name="role" size={16} />New role</Link>}
      />

      {error && <Banner kind="error">{error}</Banner>}

      {metric && (
        <p className="row small" style={{ gap: 8 }}>
          <span>Showing: <strong>{METRIC_FILTER_LABELS[metric]}</strong></span>
          <button type="button" className="btn ghost sm" onClick={clearMetric}><Icon name="close" size={14} />Show all roles</button>
        </p>
      )}

      {searchError && <Banner kind="error">The search did not finish. {searchError}</Banner>}

      <div className="card">
        <div className="filter-bar" role="search" aria-label="Filter roles">
          <div className="filter-field filter-field-search">
            <label htmlFor={`${fieldId}-q`}>Search</label>
            <input
              id={`${fieldId}-q`}
              type="search"
              placeholder="Title, job description or scorecard…"
              value={draft}
              maxLength={MAX_ROLE_SEARCH_LENGTH}
              onChange={(e) => setDraft(e.target.value)}
              aria-describedby={`${fieldId}-count`}
            />
          </div>
          <div className="filter-field">
            <label htmlFor={`${fieldId}-domain`}>Domain</label>
            <select id={`${fieldId}-domain`} value={domain} onChange={(e) => updateFilters({ domain: e.target.value })}>
              <option value="">All</option>
              {domainOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor={`${fieldId}-band`}>Experience</label>
            <select id={`${fieldId}-band`} value={band} onChange={(e) => updateFilters({ band: e.target.value })}>
              <option value="">All</option>
              {bandOptions.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor={`${fieldId}-region`}>Region</label>
            <select id={`${fieldId}-region`} value={region} onChange={(e) => updateFilters({ region: e.target.value })}>
              <option value="">All</option>
              {regionOptions.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor={`${fieldId}-status`}>Status</label>
            <select id={`${fieldId}-status`} value={status} onChange={(e) => updateFilters({ status: e.target.value as RoleStatusFilter })}>
              <option value="all">Active roles</option>
              <option value="draft">Draft</option>
              <option value="approved">Approved</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>
        <div className="filter-summary">
          {/* Announced politely, and only when the text changes. */}
          <span id={`${fieldId}-count`} className="muted small" role="status">{formatRoleCount(visible.length, roles.length)}</span>
          {pending && <span className="muted small filter-searching">Searching…</span>}
          {/* With no rows, the empty state below carries the same action. */}
          {hasActiveFilters({ ...filters, q: draft }, metric) && visible.length > 0 && (
            <button type="button" className="btn ghost sm" onClick={clearFilters}><Icon name="close" size={14} />Clear filters</button>
          )}
        </div>

        {/* A failed load is not an empty tenant: the banner says what went wrong. */}
        {error ? null : roles.length === 0 ? (
          <EmptyState
            icon="role"
            title="No roles yet"
            message="Create a role from a job description, approve its scorecard, then add candidates."
            action={<Link className="btn" to="/roles/new"><Icon name="role" size={16} />New role</Link>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon="search"
            title="No matches"
            message="No role matches the current filters."
            action={<button type="button" className="btn secondary sm" onClick={clearFilters}><Icon name="close" size={14} />Clear filters</button>}
          />
        ) : (
          <>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Roles">
              <table>
                <thead>
                  <tr>
                    {COLUMNS.slice(0, 1).map((column) => (
                      <th key={column.key} aria-sort={sortKey === column.key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <button type="button" className="link-button" onClick={() => setSort(column.key)}>{column.label}</button>
                      </th>
                    ))}
                    <th>Status</th>
                    {COLUMNS.slice(1, 2).map((column) => (
                      <th key={column.key} aria-sort={sortKey === column.key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <button type="button" className="link-button" onClick={() => setSort(column.key)}>{column.label}</button>
                      </th>
                    ))}
                    <th>Invited</th>
                    {COLUMNS.slice(2).map((column) => (
                      <th key={column.key} aria-sort={sortKey === column.key ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <button type="button" className="link-button" onClick={() => setSort(column.key)}>{column.label}</button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((role) => (
                    <tr key={role.id} data-testid="role-row">
                      <td>
                        <Link to={`/roles/${role.id}`}>{labelById.get(role.id) ?? role.title}</Link>
                        <div className="muted small">{roleDetailLine(role)}</div>
                      </td>
                      <td><StatusBadge kind="role" value={role.status} /></td>
                      <td>{role.applied}</td>
                      <td>{role.interviewInvited}</td>
                      <td>{role.interviewed}</td>
                      <td>{role.awaitingReview}</td>
                      <td>{formatAdvanceRate(role.advanceRate)}</td>
                      <td>{formatTurnaround(role.medianInviteToCompleteHours)}</td>
                      <td className={role.lastActivityAt ? 'small' : 'muted'}>{formatDate(role.lastActivityAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details style={{ marginTop: 12 }}>
              <summary>How these are counted</summary>
              <p className="muted small">Applied: candidates attached to the role.</p>
              <p className="muted small">Invited: distinct candidates with an interview invitation. Interviewed: distinct candidates who finished an interview. Retakes do not double count.</p>
              <p className="muted small">Awaiting review: sessions in review-ready state.</p>
              <p className="muted small">Rates need at least 5 decisions; withdrawn decisions are excluded.</p>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
