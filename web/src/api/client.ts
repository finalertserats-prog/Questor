// Thin typed fetch client for the Questor API.
//
// The JWT is no longer stored here. It lives in an httpOnly cookie the browser
// attaches automatically, so an XSS on this origin cannot read it and it does
// not linger in localStorage for whoever next uses the shared office machine.
// What this file *does* read is the non-httpOnly CSRF cookie, which we echo in
// a header on state-changing calls — the double-submit pattern the server
// enforces on cookie-authenticated writes.

import { interpretResponse, isNetworkFailure, NETWORK_MESSAGE, TIMEOUT_MESSAGE, UNREADABLE_MESSAGE } from './responseModel';

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
    // Still an ApiError with status 0, so callers that tell "no answer" from a
    // refusal keep working; only the wording the person sees changes.
    if (isNetworkFailure(err)) throw new ApiError(0, NETWORK_MESSAGE);
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

/** The name the server gave the file, out of `Content-Disposition`. */
function attachmentName(header: string | null): string | null {
  const quoted = /filename="([^"]+)"/.exec(header ?? '')?.[1];
  return quoted?.trim() || null;
}

/**
 * Hand a generated file to the browser.
 *
 * A revoked object URL is not optional housekeeping: without it the blob stays
 * alive for the life of the tab, and a scorecard PDF is megabytes each time
 * someone clicks.
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  // Firefox only dispatches the click on a link that is in the document.
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * A file the server renders rather than a JSON payload — today, the approved
 * scorecard as a PDF.
 *
 * No CSRF header: it is the double-submit half of a *state-changing* call, and
 * the server asks for it on unsafe methods only. The session still travels in
 * the cookie, so `credentials: 'include'` is what makes this work when the API
 * is on another origin than the SPA.
 *
 * A refusal arrives as JSON with a 4xx. Reading the body as a file regardless
 * of status is how a download button ends up saving a file containing the word
 * "Forbidden", so the bytes are only treated as a file once the answer is ok;
 * anything else goes through the same interpretation as every other call and
 * reaches the page as an ApiError it already knows how to show.
 */
async function download(path: string, fallbackFilename: string, opts?: RequestOptions): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'GET', credentials: 'include', signal: requestSignal(opts?.signal) });
  } catch (err: unknown) {
    if (isAbort(err)) throw new ApiError(0, TIMEOUT_MESSAGE);
    if (isNetworkFailure(err)) throw new ApiError(0, NETWORK_MESSAGE);
    throw err;
  }
  if (!res.ok) {
    const outcome = interpretResponse({ ok: false, status: res.status, statusText: res.statusText, text: await res.text() });
    if (outcome.kind === 'error') throw new ApiError(outcome.status, outcome.message, outcome.code);
    throw new ApiError(res.status, UNREADABLE_MESSAGE);
  }
  saveBlob(await res.blob(), attachmentName(res.headers.get('Content-Disposition')) ?? fallbackFilename);
}

export const api = {
  get: <T>(p: string, opts?: RequestOptions) => req<T>('GET', p, undefined, false, opts),
  /** Saves the answer as a file instead of parsing it; see `download` above. */
  download,
  post: <T>(p: string, body?: unknown) => req<T>('POST', p, body),
  put: <T>(p: string, body?: unknown) => req<T>('PUT', p, body),
  patch: <T>(p: string, body?: unknown) => req<T>('PATCH', p, body),
  del: <T>(p: string, body?: unknown) => req<T>('DELETE', p, body),
  postForm: <T>(p: string, form: FormData) => req<T>('POST', p, form, true),
  // Public portal helpers reuse the same fetch; they carry no session cookie
  // and the server exempts /api/portal/* from CSRF.
};
