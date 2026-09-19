import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import {
  filtersToQuery, pruneSelection, runNowDisabled,
  type CatalogProposalView, type CatalogReviewFilters, type CatalogRunView, type EditOptions, type PageMeta,
} from './catalogReviewModel';

interface ProposalsResponse { readonly proposals: CatalogProposalView[]; readonly meta: PageMeta & { readonly pendingTotal: number } }
interface RunsResponse { readonly active: boolean; readonly runs: CatalogRunView[] }

/** While a run is going, look again this often; it can take many minutes. */
const RUN_POLL_MS = 10_000;

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) return 'Only the platform owner can review the shared catalog.';
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The review page's server state: the filtered queue, the runs and the edit
 * options. A failed load is kept as an error, never shown as an empty queue.
 */
export function useCatalogReviewData(filters: CatalogReviewFilters, page: number, enabled: boolean) {
  const [proposals, setProposals] = useState<CatalogProposalView[]>([]);
  const [meta, setMeta] = useState<ProposalsResponse['meta'] | null>(null);
  const [runs, setRuns] = useState<CatalogRunView[]>([]);
  const [runActive, setRunActive] = useState(false);
  const [options, setOptions] = useState<EditOptions>({ domains: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const query = filtersToQuery(filters, page);
  const latestQuery = useRef(query);
  latestQuery.current = query;

  const loadProposals = useCallback(async () => {
    const asked = query;
    try {
      const data = await api.get<ProposalsResponse>(`/catalog-review/proposals?${asked}`);
      // A slow answer to an older filter must not replace the current one.
      if (latestQuery.current !== asked) return;
      setProposals(data.proposals);
      setMeta(data.meta);
      setSelected((current) => pruneSelection(current, data.proposals));
      setLoadError('');
    } catch (err: unknown) {
      if (latestQuery.current === asked) setLoadError(messageOf(err, 'The proposals could not be loaded.'));
    } finally {
      if (latestQuery.current === asked) setLoading(false);
    }
  }, [query]);

  const loadRuns = useCallback(async () => {
    try {
      const data = await api.get<RunsResponse>('/catalog-review/runs');
      setRuns(data.runs);
      setRunActive(data.active);
    } catch (err: unknown) {
      setLoadError(messageOf(err, 'The recent runs could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    void loadProposals();
  }, [enabled, loadProposals]);

  useEffect(() => {
    if (!enabled) return;
    void loadRuns();
    api.get<EditOptions>('/catalog-review/options')
      .then(setOptions)
      .catch((err: unknown) => setLoadError(messageOf(err, 'The domains could not be loaded.')));
  }, [enabled, loadRuns]);

  // Follow a run in progress, and refresh the queue once it has finished.
  const wasActive = useRef(false);
  useEffect(() => {
    if (!enabled) return undefined;
    const busy = runNowDisabled(runs, runActive);
    if (wasActive.current && !busy) void loadProposals();
    wasActive.current = busy;
    if (!busy) return undefined;
    const timer = setTimeout(() => { void loadRuns(); }, RUN_POLL_MS);
    return () => clearTimeout(timer);
  }, [enabled, runActive, runs, loadRuns, loadProposals]);

  return { proposals, meta, runs, runActive, options, loading, loadError, selected, setSelected, loadProposals, loadRuns, setLoadError };
}
