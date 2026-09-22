/**
 * Paging for the operator lists (candidates, interviews). Kept free of React
 * so it can be unit tested (see web/tests/listPagingModel.test.ts).
 *
 * The sizes match the server's fixed set exactly; anything else is refused
 * there, so a stale or hand-edited address falls back to the default here
 * rather than turning into an error page.
 */

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

/** Which list a remembered size belongs to. */
export type PagedList = 'candidates' | 'interviews';

export interface PageMeta {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

const STORAGE_PREFIX = 'questor.pageSize.';

export function isPageSize(value: number): value is PageSize {
  return (PAGE_SIZES as readonly number[]).includes(value);
}

/** A page size from an address or storage; null when it is not one we offer. */
export function parsePageSize(raw: string | null | undefined): PageSize | null {
  if (!raw || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return isPageSize(n) ? n : null;
}

/** A 1-based page number from an address; 1 when missing or malformed. */
export function parsePage(raw: string | null | undefined): number {
  if (!raw || !/^\d{1,6}$/.test(raw)) return 1;
  return Math.max(1, Number(raw));
}

/** Enough of the Storage interface to read and write one key. */
export interface SizeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The size this person last chose for this list. Storage can be missing or
 * throw (private windows, blocked site data); that is never an error, only the
 * default.
 */
export function readStoredPageSize(store: SizeStore | null | undefined, list: PagedList): PageSize {
  try {
    return parsePageSize(store?.getItem(STORAGE_PREFIX + list)) ?? DEFAULT_PAGE_SIZE;
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
}

export function writeStoredPageSize(store: SizeStore | null | undefined, list: PagedList, size: PageSize): void {
  try {
    store?.setItem(STORAGE_PREFIX + list, String(size));
  } catch {
    // Remembering the choice is a convenience; the page works without it.
  }
}

/** The browser's localStorage, or null where touching it throws. */
export function browserSizeStore(): SizeStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** "26–50 of 83", or "No results" for an empty list. */
export function pageRangeLabel(meta: PageMeta, noun: string, nounPlural = `${noun}s`): string {
  if (meta.total <= 0) return `No ${nounPlural}`;
  const first = (meta.page - 1) * meta.pageSize + 1;
  if (first > meta.total) return `${meta.total} ${meta.total === 1 ? noun : nounPlural}`;
  const last = Math.min(meta.total, meta.page * meta.pageSize);
  return `${first}–${last} of ${meta.total} ${meta.total === 1 ? noun : nounPlural}`;
}

/**
 * The page numbers to offer as buttons: the first, the last, and the pages
 * either side of the current one, with null where a run is skipped.
 */
export function pageButtons(page: number, pages: number): readonly (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const wanted = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  return sorted.flatMap((n, i) => (i > 0 && n - sorted[i - 1] > 1 ? [null, n] : [n]));
}

export interface ListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly q?: string;
  /** Extra filters, sent as given when non-empty. */
  readonly extra?: Readonly<Record<string, string | undefined>>;
}

/** The API path for one page: `/candidates?page=2&pageSize=50&q=ada`. */
export function listApiPath(base: string, query: ListQuery): string {
  const params = new URLSearchParams();
  params.set('page', String(query.page));
  params.set('pageSize', String(query.pageSize));
  const q = query.q?.trim();
  if (q) params.set('q', q);
  Object.entries(query.extra ?? {}).forEach(([key, value]) => { if (value) params.set(key, value); });
  return `${base}?${params.toString()}`;
}

/**
 * The page address after a change, keeping any other parameters (a dashboard
 * filter like ?state=stopped). The defaults are left out so a plain /candidates
 * stays plain.
 */
export function nextSearchParams(current: URLSearchParams, change: { page?: number; pageSize?: PageSize; q?: string }): URLSearchParams {
  const next = new URLSearchParams(current);
  const set = (key: string, value: string | null) => { if (value) next.set(key, value); else next.delete(key); };
  if (change.page !== undefined) set('page', change.page > 1 ? String(change.page) : null);
  if (change.pageSize !== undefined) set('pageSize', String(change.pageSize));
  if (change.q !== undefined) set('q', change.q.trim() || null);
  return next;
}
