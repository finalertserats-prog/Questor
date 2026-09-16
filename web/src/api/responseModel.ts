/**
 * What a response body means, decided without touching fetch so it can be unit
 * tested (see web/tests/responseModel.test.ts).
 */

/** Shown when the request never got an answer in time. */
export const TIMEOUT_MESSAGE = 'The server took too long to answer.';

/** Shown when an answer arrived but was not something this client can read. */
export const UNREADABLE_MESSAGE = 'The server sent an unreadable response.';

export interface RawResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly text: string;
}

export type Interpreted =
  | { readonly kind: 'data'; readonly data: unknown }
  | { readonly kind: 'error'; readonly status: number; readonly message: string };

function parseJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(text) as unknown };
  } catch {
    return { parsed: false };
  }
}

function statedError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const error = (value as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() ? error : null;
}

/**
 * Turn a response into either data or an error.
 *
 * WHY the unreadable case exists: a proxy or load balancer answering for the
 * API sends an HTML error page, sometimes with status 200. Wrapping that as
 * { raw } and casting it to the caller's type let every page render itself
 * from a body it had never understood — blank fields, no error, nothing in the
 * console. An answer this client cannot read is a failure, and says so.
 *
 * An empty body stays valid data (null): a 204, and every endpoint whose
 * callers ignore the result, depend on it.
 */
export function interpretResponse(res: RawResponse): Interpreted {
  const body = res.text.trim() ? parseJson(res.text) : ({ parsed: true, value: null } as const);

  if (!res.ok) {
    const stated = body.parsed ? statedError(body.value) : null;
    return { kind: 'error', status: res.status, message: stated ?? (res.statusText || UNREADABLE_MESSAGE) };
  }
  if (!body.parsed) return { kind: 'error', status: res.status, message: UNREADABLE_MESSAGE };
  return { kind: 'data', data: body.value };
}
