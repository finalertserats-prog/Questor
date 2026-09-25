import { logger } from '../../logger.js';
import { PROVIDER_LABEL, type VendorId } from './types.js';

// One way to call a meeting vendor: bounded in time, never following redirects,
// retrying only what is safe to repeat, and turning every failure into a
// sentence a recruiter can act on.
//
// Vendor response bodies are never logged or returned. Token-endpoint errors
// can quote the client id, API errors can echo request detail, and success
// bodies from token endpoints carry live credentials.

export const VENDOR_API_TIMEOUT_MS = 10_000;
// Pauses before the second and third attempt of an idempotent call.
const RETRY_DELAYS_MS = [250, 750] as const;
const MAX_RETRY_AFTER_MS = 5_000;

export class MeetingProviderError extends Error {
  constructor(
    readonly provider: VendorId,
    /** Safe to show a recruiter: no vendor text, no credential. */
    readonly userMessage: string,
    readonly status?: number,
  ) {
    super(userMessage);
    this.name = 'MeetingProviderError';
  }
}

export interface VendorRequest {
  readonly provider: VendorId;
  /** Short label for logs, e.g. "create" or "token". */
  readonly operation: string;
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * True only when repeating the call cannot do anything twice. A create is
   * never retried: a timeout does not prove the vendor did not book it.
   */
  readonly idempotent: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response, fallback: number): number {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS) : fallback;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function networkError(req: VendorRequest, err: unknown): MeetingProviderError {
  const label = PROVIDER_LABEL[req.provider];
  const errorName = (err as { name?: string } | null)?.name ?? 'Error';
  logger.warn({ provider: req.provider, operation: req.operation, errorName }, 'Meeting vendor unreachable');
  if (errorName === 'TimeoutError' || errorName === 'AbortError') {
    return new MeetingProviderError(req.provider, `${label} did not respond in time. Try again, or add a meeting link manually.`);
  }
  return new MeetingProviderError(req.provider, `${label} could not be reached from the server. Try again, or add a meeting link manually.`);
}

/**
 * Sends the request, retrying network failures, 429 and 5xx when the call is
 * idempotent. Returns the final response whatever its status; callers decide
 * what a non-2xx means for their operation.
 */
export async function vendorFetch(req: VendorRequest): Promise<Response> {
  const attempts = req.idempotent ? RETRY_DELAYS_MS.length + 1 : 1;
  for (let attempt = 1; ; attempt += 1) {
    const lastAttempt = attempt >= attempts;
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        // A redirect would re-send the bearer token or client secret to
        // wherever it points. None of these endpoints redirect.
        redirect: 'error',
        signal: AbortSignal.timeout(VENDOR_API_TIMEOUT_MS),
      });
    } catch (err) {
      if (lastAttempt) throw networkError(req, err);
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
      continue;
    }
    if (lastAttempt || !isRetryableStatus(res.status)) return res;
    await discardBody(res);
    await sleep(retryAfterMs(res, RETRY_DELAYS_MS[attempt - 1]));
  }
}

/** Release an unread body now rather than at garbage collection. */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

export interface FailureHints {
  /** Said on a 404, e.g. naming the organiser variable. */
  readonly notFound?: string;
}

/** Turn a non-2xx response into an error a recruiter can read. Consumes the body. */
export async function vendorFailure(req: VendorRequest, res: Response, hints: FailureHints = {}): Promise<MeetingProviderError> {
  await discardBody(res);
  logger.warn({ provider: req.provider, operation: req.operation, status: res.status }, 'Meeting vendor rejected the request');
  const label = PROVIDER_LABEL[req.provider];
  const status = res.status;
  const message = ((): string => {
    if (status === 401 || (req.operation === 'token' && status === 400)) {
      return `${label} did not accept Questor's credentials. An admin should check the ${label} connector in Admin → Connectors.`;
    }
    if (status === 403) {
      return `${label} refused permission to manage meetings. An admin should check the app's permissions in Admin → Connectors → How to set up.`;
    }
    if (status === 404 && hints.notFound) return hints.notFound;
    if (status === 429) return `${label} is rate-limiting requests. Try again in a minute, or add a meeting link manually.`;
    if (status >= 500) return `${label} is having problems right now (HTTP ${status}). Try again later, or add a meeting link manually.`;
    return `${label} rejected the meeting request (HTTP ${status}). Add a meeting link manually, and ask an admin to check the connector.`;
  })();
  return new MeetingProviderError(req.provider, message, status);
}

/** Parse a JSON success body, or fail with a clear message instead of a crash. */
export async function readJson(req: VendorRequest, res: Response): Promise<Record<string, unknown>> {
  const data: unknown = await res.json().catch(() => null);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new MeetingProviderError(req.provider, `${PROVIDER_LABEL[req.provider]} sent a response Questor could not read. Try again, or add a meeting link manually.`);
  }
  return data as Record<string, unknown>;
}

/**
 * A join URL is shown to recruiters as a link, so only https is accepted — a
 * vendor (or anything impersonating one) must not be able to plant a
 * javascript: or http: link in the UI.
 */
export function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function missingJoinUrl(provider: VendorId): MeetingProviderError {
  return new MeetingProviderError(provider, `${PROVIDER_LABEL[provider]} created the meeting but did not return a join link. Add a meeting link manually.`);
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' } as const;
