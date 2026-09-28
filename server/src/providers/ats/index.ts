import { logger } from '../../logger.js';

// ATS connector abstraction (BRD FR-040). Generic REST connector ships by
// default; Greenhouse is the named-provider seam.
//
// A client is built from one organisation's credentials
// (services/atsConnections.ts). There is deliberately no deployment-wide
// client any more: a single shared ATS let every tenant read every requisition
// in it and push to any candidate id it could type.
//
// Nothing an ATS sends back on failure is returned or logged beyond the HTTP
// status: error bodies can quote keys, and the caller's message is ours.

export const ATS_PROVIDERS = ['generic', 'greenhouse'] as const;
export type AtsProviderName = (typeof ATS_PROVIDERS)[number];

export function isAtsProviderName(v: string): v is AtsProviderName {
  return (ATS_PROVIDERS as readonly string[]).includes(v);
}

/**
 * Opaque vendor identifiers are alphanumeric with dashes or underscores. Every
 * id is spliced into a URL, so anything else (a slash, a dot, a query string)
 * is refused before it gets near one.
 */
export const ATS_EXTERNAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const ATS_TIMEOUT_MS = 10_000;

export interface AtsCredentials {
  readonly provider: AtsProviderName;
  readonly baseUrl: string;
  readonly accountId: string;
  readonly apiKey: string;
}

export interface AtsRequisition {
  externalId: string;
  title: string;
  description: string;
  level?: string;
  location?: string;
}

export interface AtsCandidate {
  externalId: string;
  fullName: string;
  email: string;
  phone: string;
}

export type AtsFailureKind = 'not_found' | 'rejected' | 'unavailable' | 'unreachable' | 'timeout' | 'bad_response';

export class AtsRequestError extends Error {
  readonly kind: AtsFailureKind;
  readonly status?: number;
  constructor(kind: AtsFailureKind, status?: number) {
    super(`ATS request failed: ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.kind = kind;
    this.status = status;
  }
}

export interface AtsTestResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface AtsClient {
  readonly name: AtsProviderName;
  fetchRequisition(externalId: string): Promise<AtsRequisition>;
  fetchCandidate(externalId: string): Promise<AtsCandidate>;
  pushAssessment(externalCandidateId: string, payload: unknown): Promise<{ status: string }>;
  testConnection(): Promise<AtsTestResult>;
}

type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function assertExternalId(id: string): void {
  // The routes validate first; this is the line that builds the URL, so it is
  // the line that must not trust anyone.
  if (!ATS_EXTERNAL_ID.test(id)) throw new AtsRequestError('not_found');
}

class GenericAtsClient implements AtsClient {
  readonly name: AtsProviderName = 'generic';
  constructor(private readonly creds: AtsCredentials) {}

  private url(path: string): string {
    return `${this.creds.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      accept: 'application/json',
      ...(this.creds.apiKey ? { authorization: `Bearer ${this.creds.apiKey}` } : {}),
      ...(this.creds.accountId ? { 'x-ats-account': this.creds.accountId } : {}),
      ...extra,
    };
  }

  private async call(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: init.method ?? 'GET',
        headers: this.headers(init.body ? { 'content-type': 'application/json' } : {}),
        body: init.body,
        // A redirect would carry the key to wherever it points.
        redirect: 'error',
        signal: AbortSignal.timeout(ATS_TIMEOUT_MS),
      });
    } catch (err) {
      const errorName = (err as { name?: string } | null)?.name ?? 'Error';
      logger.warn({ provider: this.name, errorName }, 'ATS unreachable');
      throw new AtsRequestError(errorName === 'TimeoutError' || errorName === 'AbortError' ? 'timeout' : 'unreachable');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      logger.warn({ provider: this.name, status: res.status }, 'ATS rejected the request');
      if (res.status === 404) throw new AtsRequestError('not_found', 404);
      if (res.status === 401 || res.status === 403) throw new AtsRequestError('rejected', res.status);
      throw new AtsRequestError('unavailable', res.status);
    }
    return res;
  }

  private async json(path: string): Promise<Json> {
    const res = await this.call(path);
    const data = (await res.json().catch(() => null)) as unknown;
    if (typeof data !== 'object' || data === null) throw new AtsRequestError('bad_response');
    return data as Json;
  }

  async fetchRequisition(externalId: string): Promise<AtsRequisition> {
    assertExternalId(externalId);
    const d = await this.json(`/requisitions/${encodeURIComponent(externalId)}`);
    return {
      externalId,
      title: str(d.title) || str(d.name),
      description: str(d.description) || str(d.jobDescription),
      level: str(d.level) || undefined,
      location: str(d.location) || undefined,
    };
  }

  async fetchCandidate(externalId: string): Promise<AtsCandidate> {
    assertExternalId(externalId);
    const d = await this.json(`/candidates/${encodeURIComponent(externalId)}`);
    const joined = [str(d.first_name) || str(d.firstName), str(d.last_name) || str(d.lastName)].filter(Boolean).join(' ');
    return {
      externalId,
      fullName: str(d.fullName) || str(d.name) || joined,
      email: str(d.email),
      phone: str(d.phone),
    };
  }

  async pushAssessment(externalCandidateId: string, payload: unknown) {
    assertExternalId(externalCandidateId);
    await this.call(`/candidates/${encodeURIComponent(externalCandidateId)}/assessments`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return { status: 'exported' };
  }

  /** The lightest authenticated read: one requisition page. Nothing is written. */
  async testConnection(): Promise<AtsTestResult> {
    try {
      await this.call('/requisitions?limit=1');
      return { ok: true, message: 'Connected: your ATS accepted these credentials.' };
    } catch (err) {
      return { ok: false, message: testFailureMessage(err) };
    }
  }
}

class GreenhouseAtsClient extends GenericAtsClient {
  override readonly name: AtsProviderName = 'greenhouse';
  // Greenhouse Harvest API shape differs; this subclass documents the seam.
}

function testFailureMessage(err: unknown): string {
  if (!(err instanceof AtsRequestError)) return 'The connection test could not be completed.';
  switch (err.kind) {
    case 'rejected': return `Your ATS rejected these credentials (HTTP ${err.status}). Check the API key and its permissions, then save and test again.`;
    case 'not_found': return 'Your ATS answered, but not at this address. Check the base URL points at the API root.';
    case 'timeout': return `Your ATS did not respond within ${ATS_TIMEOUT_MS / 1000} seconds. Try again shortly.`;
    case 'unreachable': return 'Could not reach your ATS from the server. Check the base URL.';
    case 'unavailable': return `Your ATS is having problems right now (HTTP ${err.status}). Try again later.`;
    case 'bad_response': return 'Your ATS answered with something that is not JSON. Check the base URL points at the API root.';
  }
}

export function createAtsClient(creds: AtsCredentials): AtsClient {
  return creds.provider === 'greenhouse' ? new GreenhouseAtsClient(creds) : new GenericAtsClient(creds);
}
