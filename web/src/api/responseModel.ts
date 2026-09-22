/**
 * What a response body means, decided without touching fetch so it can be unit
 * tested (see web/tests/responseModel.test.ts).
 */

/** Shown when the request never got an answer in time. */
export const TIMEOUT_MESSAGE = 'The server took too long to answer.';

/**
 * Shown when the request never reached the server at all: offline, a dropped
 * connection, a blocked request. The browser's own words for this ("Failed to
 * fetch", "NetworkError when attempting to fetch resource", "Load failed")
 * differ by browser and mean nothing to the person reading them — a candidate
 * least of all.
 */
export const NETWORK_MESSAGE = 'We could not reach Questor. Check your internet connection and try again.';

/** A fetch that threw before any response arrived: a TypeError in every browser. */
export function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError;
}

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
  | { readonly kind: 'error'; readonly status: number; readonly message: string; readonly code?: string; readonly candidateId?: string };

function parseJson(text: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(text) as unknown };
  } catch {
    return { parsed: false };
  }
}

/** A machine-readable refusal code, when the server attached one. */
function statedCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : null;
}

/** The existing application a candidate_exists refusal points at. */
function statedCandidateId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidateId = (value as { candidateId?: unknown }).candidateId;
  return typeof candidateId === 'string' && candidateId ? candidateId : null;
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
    const code = body.parsed ? statedCode(body.value) : null;
    const candidateId = body.parsed ? statedCandidateId(body.value) : null;
    return {
      kind: 'error', status: res.status, message: stated ?? (res.statusText || UNREADABLE_MESSAGE),
      ...(code ? { code } : {}), ...(candidateId ? { candidateId } : {}),
    };
  }
  if (!body.parsed) return { kind: 'error', status: res.status, message: UNREADABLE_MESSAGE };
  return { kind: 'data', data: body.value };
}
