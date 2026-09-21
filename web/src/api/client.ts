// Thin typed fetch client for the Questor API.
//
// The JWT is no longer stored here. It lives in an httpOnly cookie the browser
// attaches automatically, so an XSS on this origin cannot read it and it does
// not linger in localStorage for whoever next uses the shared office machine.
// What this file *does* read is the non-httpOnly CSRF cookie, which we echo in
// a header on state-changing calls — the double-submit pattern the server
// enforces on cookie-authenticated writes.

import { interpretResponse, TIMEOUT_MESSAGE } from './responseModel';

const CSRF_COOKIE = 'questor_csrf';
// Long enough for the slowest thing the API does honestly (an LLM-backed
// scorecard draft), short enough that a hung request ends in an error rather
// than a spinner nobody ever returns from.
const REQUEST_TIMEOUT_MS = 30_000;
const CSRF_HEADER = 'X-CSRF-Token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const cookie = part.trim();
    if (cookie.startsWith(prefix)) return decodeURIComponent(cookie.slice(prefix.length));
  }
  return null;
}

/**
 * Session-presence signal for the auth context, which calls this before hitting
 * /auth/me on load. The JWT itself is httpOnly and unreadable by design, so we
 * report the presence of its lockstep companion: the CSRF cookie is set at
 * login and cleared at logout alongside the session cookie, with the same
 * max-age. The returned value is NOT a credential — the server never accepts it
 * as one — it only answers "was a session established?".
 */
export function getToken(): string | null {
  return readCookie(CSRF_COOKIE);
}

/**
 * Only setToken(null) — "end the session" — still does anything. Clearing an
 * httpOnly cookie is impossible from JS, so it has to go through the server.
 * A non-null argument is ignored: login/register already established the
 * cookies via Set-Cookie, and re-storing the JWT here is exactly what we
 * removed.
 */
export function setToken(t: string | null) {
  if (t !== null) return;
  // Fire-and-forget: the caller updates local UI state synchronously, and a
  // failed logout request must not leave the user staring at a logged-in UI.
  // The cookies expire on their own within the hour regardless.
  void req('POST', '/auth/logout').catch(() => undefined);
}

export class ApiError extends Error {
  status: number;
  /** Set when the server named the refusal (e.g. ATS_NOT_CONNECTED). */
  code?: string;
  /** Set on candidate_exists: the application already there. */
  candidateId?: string;
  constructor(status: number, message: string, code?: string, candidateId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.candidateId = candidateId;
  }
}

export interface RequestOptions {
  /** Aborts this request, e.g. when the component that asked for it unmounts. */
  readonly signal?: AbortSignal;
}

/**
 * The deadline always applies; a caller's own signal is added to it. Without
 * AbortSignal.any (older browsers) the caller's signal wins, because a request
 * nobody is waiting for any more is worse than one without a timeout.
 */
function requestSignal(external?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!external) return deadline;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([external, deadline]) : external;
}

async function req<T>(method: string, path: string, body?: unknown, isForm = false, opts?: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {};
  if (UNSAFE_METHODS.has(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }
  let payload: BodyInit | undefined;
  if (isForm) {
    payload = body as FormData;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  // `credentials: 'include'` so the session cookie rides along even when the
  // API is served from a different origin than the SPA.
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: payload,
      credentials: 'include',
      // Without a deadline a request that never answers — a hung proxy, a
      // dropped connection the OS has not noticed — leaves the page on its
      // loading state forever, with no error and no way forward.
      signal: requestSignal(opts?.signal),
    });
  } catch (err: unknown) {
    if (isAbort(err)) throw new ApiError(0, TIMEOUT_MESSAGE);
    throw err;
  }
  const text = await res.text();
  const outcome = interpretResponse({ ok: res.ok, status: res.status, statusText: res.statusText, text });
  if (outcome.kind === 'error') throw new ApiError(outcome.status, outcome.message, outcome.code, outcome.candidateId);
  return outcome.data as T;
}

/** Both names appear across browsers for a signal that ran out of time. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export const api = {
  get: <T>(p: string, opts?: RequestOptions) => req<T>('GET', p, undefined, false, opts),
  post: <T>(p: string, body?: unknown) => req<T>('POST', p, body),
  put: <T>(p: string, body?: unknown) => req<T>('PUT', p, body),
  patch: <T>(p: string, body?: unknown) => req<T>('PATCH', p, body),
  del: <T>(p: string, body?: unknown) => req<T>('DELETE', p, body),
  postForm: <T>(p: string, form: FormData) => req<T>('POST', p, form, true),
  // Public portal helpers reuse the same fetch; they carry no session cookie
  // and the server exempts /api/portal/* from CSRF.
};
