import { z } from 'zod';

/**
 * Paging shared by the operator lists (candidates, interviews).
 *
 * The sizes are a fixed set rather than a range: the web offers exactly these,
 * and a free number is how one request asks for the whole tenant again, which
 * is the load this paging exists to stop.
 */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE = 100_000;
export const LIST_SEARCH_MAX_CHARS = 200;

// A repeated `?pageSize=25&pageSize=50` arrives as an array; z.coerce would
// turn that into NaN or a joined string, so a string is required first.
const wholeNumber = z.string().regex(/^\d{1,6}$/, 'Expected a whole number').transform(Number);

export const pagingQuerySchema = z.object({
  page: wholeNumber.pipe(z.number().int().min(1).max(MAX_PAGE)).default('1'),
  pageSize: wholeNumber
    .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), { message: `Page size must be one of ${PAGE_SIZES.join(', ')}` })
    .default(String(DEFAULT_PAGE_SIZE)),
  q: z.string().trim().max(LIST_SEARCH_MAX_CHARS).optional(),
});

export interface Paging {
  readonly page: number;
  readonly pageSize: number;
}

export interface PageMeta {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** The same number as pageSize, under the name the audit and library lists use. */
  readonly limit: number;
}

export function pageMeta(total: number, paging: Paging): PageMeta {
  return { total, page: paging.page, pageSize: paging.pageSize, limit: paging.pageSize };
}

export function skipFor(paging: Paging): number {
  return (paging.page - 1) * paging.pageSize;
}

/** Case-folded for comparison; locale-independent so the server's locale never changes an answer. */
export const foldText = (text: string): string => text.normalize('NFKC').toLowerCase();

/** True when any of the fields contains the (already folded) needle. */
export function anyFieldMatches(needle: string, fields: readonly (string | null | undefined)[]): boolean {
  return fields.some((field) => !!field && foldText(field).includes(needle));
}
