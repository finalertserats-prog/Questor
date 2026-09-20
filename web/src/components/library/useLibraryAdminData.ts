import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import type { EntryView, LibraryOverview, PoolRow, StratumRow } from './libraryAdminModel';

interface QueueResponse { readonly entries: EntryView[]; readonly meta: { readonly total: number; readonly page: number; readonly limit: number } }

/** The worker row changes by the minute while it runs; the rest is read on demand. */
const OVERVIEW_POLL_MS = 30_000;

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) return 'Only the platform owner can see the question library.';
  if (err instanceof ApiError && err.status === 404) return 'The question library is switched off on this server (LIBRARY_ENABLED=false).';
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The screen's server state. A failed load stays an error on screen; it is
 * never shown as an empty library.
 */
export function useLibraryAdminData(enabled: boolean) {
  const [overview, setOverview] = useState<LibraryOverview | null>(null);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [queue, setQueue] = useState<EntryView[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [sample, setSample] = useState<EntryView[]>([]);
  const [strata, setStrata] = useState<StratumRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api.get<LibraryOverview>('/library/admin/overview'));
      setLoadError('');
    } catch (err: unknown) {
      setLoadError(messageOf(err, 'The library overview could not be loaded.'));
    }
  }, []);

  const loadPools = useCallback(async () => {
    try {
      setPools((await api.get<{ pools: PoolRow[] }>('/library/admin/pools')).pools);
    } catch (err: unknown) {
      setLoadError(messageOf(err, 'Pool health could not be loaded.'));
    }
  }, []);

  const loadQueue = useCallback(async () => {
    try {
      const data = await api.get<QueueResponse>('/library/admin/queue?limit=50');
      setQueue(data.entries);
      setQueueTotal(data.meta.total);
    } catch (err: unknown) {
      setLoadError(messageOf(err, 'The owner queue could not be loaded.'));
    }
  }, []);

  const loadSample = useCallback(async () => {
    try {
      setSample((await api.get<{ entries: EntryView[] }>('/library/admin/sample')).entries);
    } catch (err: unknown) {
      setLoadError(messageOf(err, 'Today\'s sample could not be loaded.'));
    }
  }, []);

  const loadStrata = useCallback(async () => {
    try {
      setStrata((await api.get<{ strata: StratumRow[] }>('/library/admin/strata')).strata);
    } catch (err: unknown) {
      setLoadError(messageOf(err, 'Rates by stratum could not be loaded.'));
    }
  }, []);

  const loadAll = useCallback(async () => {
    await Promise.all([loadOverview(), loadPools(), loadQueue(), loadSample(), loadStrata()]);
    setLoading(false);
  }, [loadOverview, loadPools, loadQueue, loadSample, loadStrata]);

  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined; }
    void loadAll();
    const timer = setInterval(() => { void loadOverview(); }, OVERVIEW_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, loadAll, loadOverview]);

  return { overview, pools, queue, queueTotal, sample, strata, loading, loadError, setLoadError, loadAll, loadOverview, loadQueue, loadSample, loadPools };
}
