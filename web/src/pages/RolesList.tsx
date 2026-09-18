import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { formatDate } from '../components/dateFormat';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { PageSkeleton } from '../components/Skeleton';
import { Badge, Banner } from '../components/ui';
import {
  filterRoles,
  formatAdvanceRate,
  formatTurnaround,
  sortRoles,
  type RoleFunnel,
  type RoleMetricsPayload,
  type RoleSortKey,
  type RoleStatusFilter,
  type SortDirection,
} from '../components/rolesListModel';

const COLUMNS: ReadonlyArray<{ key: RoleSortKey; label: string }> = [
  { key: 'title', label: 'Role' },
  { key: 'applied', label: 'Applied' },
  { key: 'interviewed', label: 'Interviewed' },
  { key: 'awaitingReview', label: 'Awaiting review' },
  { key: 'advanceRate', label: 'Advance rate' },
  { key: 'medianInviteToCompleteHours', label: 'Invite→complete' },
  { key: 'lastActivityAt', label: 'Last activity' },
];

function nextDirection(active: boolean, current: SortDirection): SortDirection {
  return active && current === 'asc' ? 'desc' : 'asc';
}

function statusBadge(status: string) {
  const kind = status === 'approved' ? 'green' : status === 'draft' ? 'amber' : 'gray';
  return <Badge kind={kind}>{status}</Badge>;
}

export function RolesList() {
  const [roles, setRoles] = useState<readonly RoleFunnel[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<RoleStatusFilter>('all');
  const [sortKey, setSortKey] = useState<RoleSortKey>('title');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Metrics are the list's source of truth: the endpoint already scopes roles
  // and candidate counts the same way the sidebar pages do.
  useEffect(() => {
    let cancelled = false;
    api.get<RoleMetricsPayload>('/roles/metrics')
      .then((d) => { if (!cancelled) setRoles(d.roles ?? []); })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError || err instanceof Error ? err.message : 'Could not load roles.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(
    () => sortRoles(filterRoles(roles, { query, status }), sortKey, direction),
    [roles, query, status, sortKey, direction],
  );

  const setSort = (key: RoleSortKey) => {
    const active = key === sortKey;
    setDirection(nextDirection(active, direction));
    setSortKey(key);
  };

  if (loading) return <PageSkeleton label="Loading roles…" />;

  return (
    <div>
      <PageHeader
        icon="role"
        title="Roles"
        actions={<Link className="btn secondary" to="/roles/new"><Icon name="role" size={16} />New role</Link>}
      />

      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        <div className="row spread" style={{ marginBottom: 12 }}>
          <input
            className="filter-input"
            placeholder="Filter by title or level…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter roles"
          />
          <select value={status} onChange={(e) => setStatus(e.target.value as RoleStatusFilter)} aria-label="Filter role status">
            <option value="all">Active roles</option>
            <option value="draft">Draft</option>
            <option value="approved">Approved</option>
            <option value="archived">Archived</option>
          </select>
          <span className="muted small">
            {visible.length === roles.length ? `${roles.length} role${roles.length === 1 ? '' : 's'}` : `${visible.length} of ${roles.length}`}
          </span>
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
            action={<button type="button" className="btn secondary sm" onClick={() => { setQuery(''); setStatus('all'); }}><Icon name="close" size={14} />Clear filters</button>}
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
                        <Link to={`/roles/${role.id}`}>{role.title}</Link>
                        <div className="muted small">{role.level || 'No level set'}</div>
                      </td>
                      <td>{statusBadge(role.status)}</td>
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
