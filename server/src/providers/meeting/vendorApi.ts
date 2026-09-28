import { accessToken, forgetAccessToken } from './tokens.js';
import { bearer, JSON_HEADERS, readJson, vendorFailure, vendorFetch, discardBody, type FailureHints, type VendorRequest } from './vendorHttp.js';
import type { VendorId } from './types.js';

// An authenticated call to a vendor's meeting API.

export interface ApiCall {
  readonly provider: VendorId;
  readonly operation: string;
  readonly method: VendorRequest['method'];
  readonly url: string;
  readonly body?: unknown;
  readonly idempotent: boolean;
  readonly hints?: FailureHints;
  /** Statuses that mean "already done" (a delete of something already gone). */
  readonly alsoOk?: readonly number[];
}

async function send(call: ApiCall): Promise<{ req: VendorRequest; res: Response }> {
  const token = await accessToken(call.provider);
  const req: VendorRequest = {
    provider: call.provider,
    operation: call.operation,
    method: call.method,
    url: call.url,
    headers: { ...JSON_HEADERS, ...bearer(token) },
    body: call.body === undefined ? undefined : JSON.stringify(call.body),
    idempotent: call.idempotent,
  };
  const res = await vendorFetch(req);
  if (res.ok || call.alsoOk?.includes(res.status)) return { req, res };
  // A revoked or expired token must not keep being served from the cache.
  if (res.status === 401) forgetAccessToken(call.provider);
  throw await vendorFailure(req, res, call.hints);
}

export async function callJson(call: ApiCall): Promise<Record<string, unknown>> {
  const { req, res } = await send(call);
  return readJson(req, res);
}

export async function callNoContent(call: ApiCall): Promise<void> {
  const { res } = await send(call);
  await discardBody(res);
}
