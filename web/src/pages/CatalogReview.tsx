import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { CatalogAttribution } from '../components/CatalogAttribution';
import { CatalogReviewFilterBar } from '../components/CatalogReviewFilters';
import { CatalogProposalRow } from '../components/CatalogProposalRow';
import { LatestRunLine, RecentRuns } from '../components/CatalogReviewRuns';
import { useCatalogReviewData } from '../components/useCatalogReviewData';
import { BulkBar } from '../components/CatalogReviewBulkBar';
import {
  BULK_MAX, bulkOutcome, runNowDisabled, decisionErrorMessage, DEFAULT_CATALOG_REVIEW_FILTERS, hasActiveFilters, paginationLabel, selectablePendingIds,
  toggleAll, toggleSelection, type BulkItemResult, type CatalogProposalView, type CatalogReviewFilters,
} from '../components/catalogReviewModel';

type Notice = { readonly kind: 'ok' | 'info' | 'error'; readonly text: string; readonly details?: readonly string[] };
type BulkAction = 'approve' | 'reject';

const SEARCH_PAUSE_MS = 300;

/**
 * The platform owner's review queue for the monthly catalog refresh. Nothing
 * the automation finds reaches the shared catalog until it is approved here.
 */
export function CatalogReview() {
  const { user } = useAuth();
  const isOperator = user?.platformOperator === true;
  const [filters, setFilters] = useState<CatalogReviewFilters>(DEFAULT_CATALOG_REVIEW_FILTERS);
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const data = useCatalogReviewData(filters, page, isOperator);
  const { proposals, meta, runs, runActive, options, loading, loadError, selected, setSelected } = data;
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BulkAction | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    if (searchDraft.trim() === filters.q) return undefined;
    const timer = setTimeout(() => { setFilters((f) => ({ ...f, q: searchDraft.trim() })); setPage(1); }, SEARCH_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, filters.q]);

  const titles = useMemo(() => new Map(proposals.map((p) => [p.id, p.title])), [proposals]);
  const pendingIds = selectablePendingIds(proposals);
  const allSelected = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));

  if (!isOperator) {
    return (
      <div>
        <PageHeader icon="list" title="Catalog review" />
        <Banner kind="info">Only the platform owner can review changes to the shared role catalog.</Banner>
      </div>
    );
  }
  if (loading && !meta && !loadError) return <PageSkeleton label="Loading catalog proposals…" />;

  const changeFilters = (change: Partial<CatalogReviewFilters>) => { setFilters((f) => ({ ...f, ...change })); setPage(1); setConfirming(null); };
  const clearFilters = () => { setSearchDraft(''); setFilters(DEFAULT_CATALOG_REVIEW_FILTERS); setPage(1); };
  const markBusy = (id: string, busy: boolean) => setBusyIds((current) => (busy ? new Set([...current, id]) : new Set([...current].filter((v) => v !== id))));

  const decide = async (proposal: CatalogProposalView, action: BulkAction) => {
    markBusy(proposal.id, true);
    try {
      // Approve names the version on screen, so an edit made meanwhile is not approved blind.
      await api.post(`/catalog-review/proposals/${proposal.id}/${action}`, action === 'approve' && proposal.updatedAt ? { updatedAt: proposal.updatedAt } : {});
      setNotice({ kind: 'ok', text: action === 'approve' ? `Approved "${proposal.title}". It is now in the shared catalog.` : `Rejected "${proposal.title}".` });
    } catch (err: unknown) {
      const apiErr = err instanceof ApiError ? err : null;
      setNotice({ kind: apiErr?.code === 'superseded' || apiErr?.code === 'changed' ? 'info' : 'error', text: decisionErrorMessage({ status: apiErr?.status, code: apiErr?.code, message: err instanceof Error ? err.message : 'Could not record that decision.' }, proposal.title) });
    } finally {
      markBusy(proposal.id, false);
      setSelected((current) => new Set([...current].filter((id) => id !== proposal.id)));
      await data.loadProposals();
    }
  };

  const save = async (proposal: CatalogProposalView, patch: Record<string, string | null>): Promise<boolean> => {
    markBusy(proposal.id, true);
    try {
      await api.patch(`/catalog-review/proposals/${proposal.id}`, patch);
      setEditingId(null);
      setNotice({ kind: 'ok', text: `Saved changes to "${typeof patch.title === 'string' ? patch.title : proposal.title}".` });
      await data.loadProposals();
      return true;
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: decisionErrorMessage({ status: err instanceof ApiError ? err.status : undefined, code: err instanceof ApiError ? err.code : undefined, message: err instanceof Error ? err.message : 'Could not save.' }, proposal.title) });
      return false;
    } finally {
      markBusy(proposal.id, false);
    }
  };

  const runBulk = async (action: BulkAction) => {
    const ids = [...selected].slice(0, BULK_MAX);
    setBulkBusy(true);
    try {
      const res = await api.post<{ results: BulkItemResult[] }>('/catalog-review/proposals/bulk', { ids, action });
      const outcome = bulkOutcome(res.results, titles, action);
      setNotice({ kind: outcome.failures.length > 0 ? 'info' : 'ok', text: outcome.message, details: outcome.failures });
      setSelected(new Set());
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'The bulk action failed. Nothing was changed.' });
    } finally {
      setBulkBusy(false);
      setConfirming(null);
      await data.loadProposals();
    }
  };

  const runNow = async () => {
    setStarting(true);
    try {
      await api.post('/catalog-review/runs', {});
      setNotice({ kind: 'ok', text: 'Catalog refresh started. It runs in the background; this page updates when it finishes.' });
    } catch (err: unknown) {
      const apiErr = err instanceof ApiError ? err : null;
      const text = apiErr?.code === 'too_soon' ? decisionErrorMessage({ code: 'too_soon', message: apiErr.message }, 'Run now')
        : apiErr?.status === 409 ? 'A catalog refresh is already running.'
          : err instanceof Error ? err.message : 'The refresh could not start.';
      setNotice({ kind: apiErr?.status === 409 ? 'info' : 'error', text });
    } finally {
      setStarting(false);
      await data.loadRuns();
    }
  };

  return (
    <div>
      <PageHeader
        icon="list"
        title="Catalog review"
        subtitle="New roles and alternative titles found by the monthly refresh. Nothing enters the shared catalog until you approve it."
        actions={(
          <button type="button" className="btn" onClick={() => void runNow()} disabled={starting || runNowDisabled(runs, runActive)} aria-describedby="catalog-latest-run">
            <Icon name="refresh" size={16} />{runNowDisabled(runs, runActive) ? 'Running…' : starting ? 'Starting…' : 'Run now'}
          </button>
        )}
      />
      <div id="catalog-latest-run"><LatestRunLine run={runs[0]} /></div>

      <div aria-live="polite" aria-atomic="true">
        {notice && (
          <Banner kind={notice.kind}>
            {notice.text}
            {notice.details && notice.details.length > 0 && <ul className="small">{notice.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
          </Banner>
        )}
      </div>
      {loadError && (
        <Banner kind="error">
          {loadError}{' '}
          <button type="button" className="btn ghost sm" onClick={() => { data.setLoadError(''); void data.loadProposals(); void data.loadRuns(); }}>Try again</button>
        </Banner>
      )}

      <div className="card">
        <CatalogReviewFilterBar filters={filters} searchDraft={searchDraft} domains={options.domains} onChange={changeFilters} onSearchDraft={setSearchDraft} />
        <div className="filter-summary">
          {meta && <span className="muted small" role="status">{paginationLabel(meta)} · {meta.pendingTotal} pending in all</span>}
          {hasActiveFilters(filters) && <button type="button" className="btn ghost sm" onClick={clearFilters}><Icon name="close" size={14} />Clear filters</button>}
        </div>

        {selected.size > 0 && (
          <BulkBar count={selected.size} confirming={confirming} busy={bulkBusy} onAsk={setConfirming} onConfirm={(action) => void runBulk(action)} onClear={() => setSelected(new Set())} />
        )}

        {loadError && proposals.length === 0 ? null : proposals.length === 0 ? (
          <EmptyState
            compact
            icon="list"
            title={hasActiveFilters(filters) ? 'No matches' : 'Nothing to review'}
            message={hasActiveFilters(filters) ? 'No proposal matches these filters.' : 'The queue is empty. The next monthly refresh will add anything new it finds.'}
            action={hasActiveFilters(filters) ? <button type="button" className="btn secondary sm" onClick={clearFilters}>Clear filters</button> : undefined}
          />
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Catalog proposals">
            <table className="catalog-review-table">
              <thead>
                <tr>
                  <th className="col-select">
                    {pendingIds.length > 0 && <input type="checkbox" checked={allSelected} onChange={() => setSelected(toggleAll(selected, proposals))} aria-label="Select every pending proposal on this page" />}
                  </th>
                  <th>Title</th><th>Kind</th><th>Domain and family</th><th>Confidence</th><th>Sources</th><th><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <CatalogProposalRow
                    key={p.id}
                    proposal={p}
                    options={options}
                    selected={selected.has(p.id)}
                    busy={busyIds.has(p.id) || bulkBusy}
                    editing={editingId === p.id}
                    onToggle={() => setSelected(toggleSelection(selected, p.id))}
                    onApprove={() => void decide(p, 'approve')}
                    onReject={() => void decide(p, 'reject')}
                    onEdit={() => setEditingId(p.id)}
                    onCancelEdit={() => setEditingId(null)}
                    onSave={(patch) => save(p, patch)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {meta && meta.totalPages > 1 && (
          <nav className="catalog-pager" aria-label="Pages">
            <button type="button" className="btn sm secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="small">{paginationLabel(meta)}</span>
            <button type="button" className="btn sm secondary" disabled={page >= meta.totalPages} onClick={() => setPage(page + 1)}>Next</button>
          </nav>
        )}
      </div>

      <RecentRuns runs={runs} />
      <CatalogAttribution />
    </div>
  );
}
