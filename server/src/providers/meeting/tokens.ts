import { createSign } from 'node:crypto';
import { readEnv } from './connectorEnv.js';
import { cachedToken, invalidateToken, tokenCacheKey } from './tokenCache.js';
import { MeetingProviderError, readJson, vendorFailure, vendorFetch, type VendorRequest } from './vendorHttp.js';
import type { VendorId } from './types.js';

// OAuth token requests for each meeting vendor. Used both by "Test connection"
// (uncached: a test must prove the credentials as they are now) and by
// meeting creation (cached).

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Meetings are created as Calendar events with a Meet conference, so this is
// the scope domain-wide delegation must grant.
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
const JWT_LIFETIME_SECONDS = 300;
const FORM = 'application/x-www-form-urlencoded';

export interface TokenRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const UNUSABLE_GOOGLE_KEY =
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY could not be read as a private key. Paste the private_key value from the JSON key file (keeping its \\n sequences), then restart the server.';

export function zoomTokenRequest(): TokenRequest {
  const basic = Buffer.from(`${readEnv('ZOOM_CLIENT_ID')}:${readEnv('ZOOM_CLIENT_SECRET')}`).toString('base64');
  const query = new URLSearchParams({ grant_type: 'account_credentials', account_id: readEnv('ZOOM_ACCOUNT_ID') });
  return {
    url: `https://zoom.us/oauth/token?${query.toString()}`,
    headers: { authorization: `Basic ${basic}`, 'content-type': FORM },
    body: '',
  };
}

export function teamsTokenRequest(): TokenRequest {
  const body = new URLSearchParams({
    client_id: readEnv('MS_GRAPH_CLIENT_ID'),
    client_secret: readEnv('MS_GRAPH_CLIENT_SECRET'),
    scope: GRAPH_DEFAULT_SCOPE,
    grant_type: 'client_credentials',
  });
  return {
    url: `https://login.microsoftonline.com/${encodeURIComponent(readEnv('MS_GRAPH_TENANT_ID'))}/oauth2/v2.0/token`,
    headers: { 'content-type': FORM },
    body: body.toString(),
  };
}

/** A signed service-account assertion, or null when the private key cannot sign. */
export function meetTokenRequest(): TokenRequest | null {
  // .env files usually hold the PEM on one line with literal "\n" sequences,
  // exactly as it appears in Google's JSON key file.
  const privateKey = readEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: readEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    sub: readEnv('GOOGLE_IMPERSONATED_USER'),
    scope: GOOGLE_CALENDAR_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + JWT_LIFETIME_SECONDS,
  })).toString('base64url');

  let signature: string;
  try {
    signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(privateKey).toString('base64url');
  } catch {
    return null;
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${header}.${claims}.${signature}`,
  });
  return { url: GOOGLE_TOKEN_URL, headers: { 'content-type': FORM }, body: body.toString() };
}

function tokenRequestFor(provider: VendorId): TokenRequest {
  switch (provider) {
    case 'zoom': return zoomTokenRequest();
    case 'teams': return teamsTokenRequest();
    case 'meet': {
      const req = meetTokenRequest();
      if (!req) throw new MeetingProviderError('meet', UNUSABLE_GOOGLE_KEY);
      return req;
    }
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled meeting vendor: ${String(unreachable)}`);
    }
  }
}

const CREDENTIAL_VARS: Readonly<Record<VendorId, readonly string[]>> = {
  zoom: ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'],
  teams: ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET'],
  meet: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GOOGLE_IMPERSONATED_USER'],
};

function cacheKey(provider: VendorId): string {
  return tokenCacheKey(provider, ...CREDENTIAL_VARS[provider].map(readEnv));
}

async function mintToken(provider: VendorId): Promise<{ token: string; expiresInSeconds?: number }> {
  const built = tokenRequestFor(provider);
  // Token requests change nothing at the vendor, so they are safe to retry.
  const req: VendorRequest = { provider, operation: 'token', method: 'POST', idempotent: true, ...built };
  const res = await vendorFetch(req);
  if (!res.ok) throw await vendorFailure(req, res);
  const data = await readJson(req, res);
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new MeetingProviderError(provider, 'The meeting provider answered without an access token. An admin should check the connector in Admin → Connectors.');
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in);
  return { token: data.access_token, expiresInSeconds: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined };
}

export function accessToken(provider: VendorId): Promise<string> {
  return cachedToken(cacheKey(provider), () => mintToken(provider));
}

/** Called when an API answers 401: the cached token is no good any more. */
export function forgetAccessToken(provider: VendorId): void {
  invalidateToken(cacheKey(provider));
}
