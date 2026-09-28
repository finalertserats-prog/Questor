import { z } from 'zod';
import type { CatalogCandidate } from '../../domain/catalogMatch.js';
import { fetchWithRetry, type SourceHttp } from './http.js';

/**
 * ESCO, the EU's occupation classification (public API, no key). Search
 * results carry only the uri and the preferred title; alternative labels and
 * the description come from the occupation resource, one request per
 * occupation. Requests are made one at a time with a pause between them: it
 * is a free public service.
 */

export interface EscoPage {
  readonly candidates: CatalogCandidate[];
  readonly total: number;
  /** Occupations whose details could not be read; they are kept, title only. */
  readonly errors: string[];
}

const searchSchema = z.object({
  total: z.number().int().nonnegative().catch(0),
  _embedded: z.object({
    results: z.array(z.object({ uri: z.string().min(1), title: z.string().catch('') }).passthrough()).catch([]),
  }).catch({ results: [] }),
}).passthrough();

const detailSchema = z.object({
  title: z.string().optional().catch(undefined),
  alternativeLabel: z.object({ en: z.array(z.unknown()).catch([]) }).partial().optional().catch(undefined),
  description: z.object({ en: z.object({ literal: z.string().catch('') }).partial().optional().catch(undefined) }).partial().optional().catch(undefined),
}).passthrough();

interface SearchHit {
  readonly uri: string;
  readonly title: string;
}

/** `page` is ESCO's `offset`: a page index, not an item offset (checked against the live API). */
function searchUrl(baseUrl: string, text: string, limit: number, page: number): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/search`);
  url.searchParams.set('type', 'occupation');
  url.searchParams.set('language', 'en');
  url.searchParams.set('text', text);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(page));
  return url.toString();
}

async function search(http: SourceHttp, baseUrl: string, text: string, limit: number, page: number): Promise<{ hits: SearchHit[]; total: number }> {
  const response = await fetchWithRetry(searchUrl(baseUrl, text, limit, page), http);
  const parsed = searchSchema.safeParse(await response.json());
  if (!parsed.success) return { hits: [], total: 0 };
  return { hits: parsed.data._embedded.results.map((row) => ({ uri: row.uri, title: row.title.trim() })), total: parsed.data.total };
}

function toCandidate(hit: SearchHit, detail: z.infer<typeof detailSchema> | null): CatalogCandidate {
  const alternates = (detail?.alternativeLabel?.en ?? []).filter((label): label is string => typeof label === 'string' && label.trim().length > 0);
  const description = detail?.description?.en?.literal?.trim();
  return {
    title: hit.title || detail?.title?.trim() || '',
    description: description || undefined,
    alternateTitles: alternates.map((label) => label.trim()),
    ref: hit.uri,
    url: hit.uri.replace(/^http:\/\//, 'https://'),
    source: 'esco',
  };
}

async function fetchDetail(http: SourceHttp, baseUrl: string, uri: string): Promise<z.infer<typeof detailSchema> | null> {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/resource/occupation`);
  url.searchParams.set('uri', uri);
  url.searchParams.set('language', 'en');
  const response = await fetchWithRetry(url.toString(), http);
  const parsed = detailSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}

export async function fetchEscoPage(
  http: SourceHttp,
  opts: { readonly baseUrl: string; readonly page: number; readonly limit: number; readonly delayMs: number },
): Promise<EscoPage> {
  const { hits, total } = await search(http, opts.baseUrl, '', opts.limit, opts.page);
  const candidates: CatalogCandidate[] = [];
  const errors: string[] = [];
  for (const hit of hits) {
    await http.sleep(opts.delayMs);
    try {
      candidates.push(toCandidate(hit, await fetchDetail(http, opts.baseUrl, hit.uri)));
    } catch (err) {
      errors.push(`${hit.title || hit.uri}: ${err instanceof Error ? err.message : String(err)}`);
      candidates.push(toCandidate(hit, null));
    }
  }
  return { candidates: candidates.filter((c) => c.title.length > 0), total, errors };
}

/** The ESCO occupation best matching an existing catalog title, for its alternative labels. */
export async function lookupEscoOccupation(
  http: SourceHttp,
  opts: { readonly baseUrl: string; readonly title: string; readonly delayMs: number },
): Promise<CatalogCandidate | null> {
  const { hits } = await search(http, opts.baseUrl, opts.title, 1, 0);
  const hit = hits[0];
  if (!hit) return null;
  await http.sleep(opts.delayMs);
  return toCandidate(hit, await fetchDetail(http, opts.baseUrl, hit.uri));
}
