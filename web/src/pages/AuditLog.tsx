import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { buildAuditQuery, pageCount, type AuditFilters } from '../components/auditLogModel';

interface AuditEvent {
  id: string; actorId: string; actorType: string; actorName: string | null;
  action: string; entityType: string; entityId: string; createdAt: string;
}
interface AuditResponse {
  events: AuditEvent[];
  meta: { total: number; page: number; limit: number };
  filters: { actions: string[]; actors: { id: string; type: string; name: string }[] };
}

const PAGE_SIZE = 50;
const EMPTY_FILTERS: AuditFilters = { action: '', actorId: '', fromDate: '', toDate: '', page: 1, limit: PAGE_SIZE };

/** The tenant's audit trail: who did what, to which record, and when. */
export function AuditLog() {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api.get<AuditResponse>(`/admin/audit?${buildAuditQuery(filters)}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError && err.status === 403
          ? 'Your role does not include access to the audit log.'
          : err instanceof Error ? err.message : 'Could not load the audit log.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters]);

  // Any filter change returns to the first page; paging keeps the filters.
  const update = (patch: Partial<AuditFilters>) => setFilters((prev) => ({ ...prev, page: 1, ...patch }));
  const pages = data ? pageCount(data.meta.total, data.meta.limit) : 1;
  const hasFilter = Boolean(filters.action || filters.actorId || filters.fromDate || filters.toDate);

  return (
    <div>
      <div className="topbar">
        <h1>Audit log</h1>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        <form className="audit-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filter audit events">
          <div>
            <label htmlFor="audit-action">Action</label>
            <select id="audit-action" value={filters.action} onChange={(e) => update({ action: e.target.value })}>
              <option value="">All actions</option>
              {(data?.filters.actions ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="audit-actor">Actor</label>
            <select id="audit-actor" value={filters.actorId} onChange={(e) => update({ actorId: e.target.value })}>
              <option value="">All actors</option>
              {(data?.filters.actors ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name}{a.type !== 'user' ? ` (${a.type})` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="audit-from">From</label>
            <input id="audit-from" type="date" value={filters.fromDate} max={filters.toDate || undefined} onChange={(e) => update({ fromDate: e.target.value })} />
          </div>
          <div>
            <label htmlFor="audit-to">To</label>
            <input id="audit-to" type="date" value={filters.toDate} min={filters.fromDate || undefined} onChange={(e) => update({ toDate: e.target.value })} />
          </div>
          <button type="button" className="btn secondary" disabled={!hasFilter} onClick={() => setFilters(EMPTY_FILTERS)}>Clear</button>
        </form>
      </div>

      <div className="card">
        {loading && !data ? <div className="muted">Loading…</div> : !data || data.events.length === 0 ? (
          <div className="muted small">{hasFilter ? 'No events match these filters.' : 'No events.'}</div>
        ) : (
          <>
            <div className="dash-table-wrap">
              <table aria-busy={loading}>
                <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.id}>
                      <td className="muted small">{new Date(e.createdAt).toLocaleString()}</td>
                      <td>{e.actorName ?? e.actorType}</td>
                      <td><code>{e.action}</code></td>
                      <td className="muted">{e.entityType}{e.entityId ? <span className="small"> · {e.entityId.slice(0, 10)}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="spread row audit-pager" aria-label="Audit log pages">
              <span className="muted small">
                {data.meta.total} event{data.meta.total === 1 ? '' : 's'} · page {data.meta.page} of {pages}
              </span>
              <span className="row">
                <button type="button" className="btn sm secondary" disabled={filters.page <= 1 || loading}
                  onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))}>Previous</button>
                <button type="button" className="btn sm secondary" disabled={filters.page >= pages || loading}
                  onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}>Next</button>
              </span>
            </nav>
          </>
        )}
      </div>
    </div>
  );
}
