import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  browserSizeStore,
  listApiPath,
  nextSearchParams,
  parsePage,
  parsePageSize,
  readStoredPageSize,
  totalPages,
  writeStoredPageSize,
  type PagedList,
  type PageMeta,
  type PageSize,
} from './listPagingModel';

/** Long enough that a word is typed before the server is asked. */
const SEARCH_DEBOUNCE_MS = 300;

export interface PagedResponse {
  readonly meta?: PageMeta;
}

export interface PagedListState<T extends PagedResponse> {
  readonly data: T | null;
  /** True until the first page has arrived. */
  readonly loading: boolean;
  /** True while a later page or search is on its way; the old rows stay up. */
  readonly refreshing: boolean;
  readonly error: string;
  readonly meta: PageMeta;
  readonly page: number;
  readonly pageSize: PageSize;
  /** The search as typed; the applied one follows it after a pause. */
  readonly draft: string;
  readonly query: string;
  readonly setDraft: (value: string) => void;
  readonly clearSearch: () => void;
  readonly setPage: (page: number) => void;
  readonly setPageSize: (size: PageSize) => void;
  readonly reload: () => void;
}

/**
 * One page of a server-paged list, with its page, size and search kept in the
 * address (so a link or the back button returns to the same page) and the
 * chosen size remembered per list.
 */
export function usePagedList<T extends PagedResponse>(options: {
  readonly list: PagedList;
  readonly base: string;
  readonly extra?: Readonly<Record<string, string | undefined>>;
  readonly failureMessage: string;
}): PagedListState<T> {
  const { list, base, extra, failureMessage } = options;
  const [params, setParams] = useSearchParams();
  const page = parsePage(params.get('page'));
  const pageSize = parsePageSize(params.get('pageSize')) ?? readStoredPageSize(browserSizeStore(), list);
  const query = (params.get('q') ?? '').trim();
  const [draft, setDraftState] = useState(query);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const extraKey = JSON.stringify(extra ?? {});
  const path = useMemo(
    () => listApiPath(base, { page, pageSize, q: query, extra: JSON.parse(extraKey) as Record<string, string | undefined> }),
    [base, page, pageSize, query, extraKey],
  );

  // `cancelled` so a response that lands after the next request (or after
  // someone has navigated away) does not overwrite what is on screen.
  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    api.get<T>(path)
      .then((d) => { if (!cancelled) { setData(d); setError(''); } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : failureMessage); })
      .finally(() => { if (!cancelled) { setLoading(false); setRefreshing(false); } });
    return () => { cancelled = true; };
  }, [path, reloadKey, failureMessage]);

  // Back/forward can change the search in the address; the box follows it.
  useEffect(() => { setDraftState(query); }, [query]);

  // The applied search follows the typing after a pause, from page one.
  useEffect(() => {
    if (draft.trim() === query) return undefined;
    const timer = window.setTimeout(() => {
      setParams((current) => nextSearchParams(current, { q: draft, page: 1 }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, query, setParams]);

  const meta: PageMeta = data?.meta ?? { total: 0, page, pageSize };

  // A page past the end (rows removed, a size change, an old link) moves to
  // the last page that has rows rather than showing an empty table.
  useEffect(() => {
    if (!data?.meta || data.meta.total === 0) return;
    const last = totalPages(data.meta.total, data.meta.pageSize);
    if (page > last) setParams((current) => nextSearchParams(current, { page: last }), { replace: true });
  }, [data, page, setParams]);

  const setPage = useCallback((next: number) => {
    setParams((current) => nextSearchParams(current, { page: next }));
  }, [setParams]);

  const setPageSize = useCallback((size: PageSize) => {
    writeStoredPageSize(browserSizeStore(), list, size);
    setParams((current) => nextSearchParams(current, { pageSize: size, page: 1 }));
  }, [list, setParams]);

  const clearSearch = useCallback(() => {
    setDraftState('');
    setParams((current) => nextSearchParams(current, { q: '', page: 1 }), { replace: true });
  }, [setParams]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  return {
    data, loading, refreshing, error, meta, page, pageSize, draft, query,
    setDraft: setDraftState, clearSearch, setPage, setPageSize, reload,
  };
}
