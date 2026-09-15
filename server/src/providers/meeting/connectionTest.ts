import { createSign } from 'node:crypto';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { readEnv, type MeetingAdapterId } from './connectorEnv.js';

// "Test connection" for meeting adapters: the lightest call that proves the
// credentials authenticate — obtaining an OAuth token — and nothing more. No
// meeting is created, no user is contacted.
//
// Nothing a vendor sends back is returned or logged beyond the HTTP status.
// Token-endpoint error bodies can quote the client id, and success bodies carry
// a live access token; both are discarded here so no caller can leak them.

export const VENDOR_TIMEOUT_MS = 8_000;
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.created';
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';
const JWT_LIFETIME_SECONDS = 300;

export interface ConnectionResult {
  readonly ok: boolean;
  readonly message: string;
}

type VendorAdapterId = Exclude<MeetingAdapterId, 'hosted'>;

const VENDOR_NAME: Readonly<Record<VendorAdapterId, string>> = {
  teams: 'Microsoft',
  zoom: 'Zoom',
  meet: 'Google',
};

// Said on success so a green test is not mistaken for "interviews now run in Zoom".
const NOT_YET_WIRED = 'Interviews keep using the hosted Questor room until meeting creation for this adapter is built.';

const REJECTION_HINT: Readonly<Record<VendorAdapterId, string>> = {
  zoom: 'Zoom rejected these credentials. Check ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET, make sure the Server-to-Server OAuth app is activated, then restart the server.',
  teams: 'Microsoft rejected these credentials. Check MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID and MS_GRAPH_CLIENT_SECRET (use the secret\'s Value, not its ID, and check it has not expired), then restart the server.',
  meet: 'Google rejected the service account. Check the key, that domain-wide delegation grants the Meet scope to this service account\'s client ID, and that GOOGLE_IMPERSONATED_USER is a user in your Workspace domain, then restart the server.',
};

interface TokenRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const FORM = 'application/x-www-form-urlencoded';

function rejectionMessage(adapter: VendorAdapterId, status: number): string {
  const vendor = VENDOR_NAME[adapter];
  if (status === 429) return `${vendor} is rate-limiting requests. Wait a minute and try again.`;
  if (status >= 500) return `${vendor} is having problems right now (HTTP ${status}). Try again later.`;
  return `${REJECTION_HINT[adapter]} (HTTP ${status})`;
}

async function requestToken(adapter: VendorAdapterId, req: TokenRequest): Promise<ConnectionResult> {
  const vendor = VENDOR_NAME[adapter];
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
  } catch (err) {
    const errorName = (err as { name?: string } | null)?.name ?? 'Error';
    logger.warn({ adapter, errorName }, 'Meeting connector test: vendor unreachable');
    if (errorName === 'TimeoutError' || errorName === 'AbortError') {
      return { ok: false, message: `${vendor} did not respond within ${VENDOR_TIMEOUT_MS / 1000} seconds. Try again, and check the server's outbound network access.` };
    }
    return { ok: false, message: `Could not reach ${vendor} from the server. Check outbound network access (firewall or proxy) and try again.` };
  }

  if (!res.ok) {
    logger.warn({ adapter, status: res.status }, 'Meeting connector test: vendor rejected the request');
    return { ok: false, message: rejectionMessage(adapter, res.status) };
  }

  const data = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (typeof data?.access_token !== 'string' || data.access_token === '') {
    return { ok: false, message: `${vendor} answered, but not with an access token. Check that the credentials belong to the kind of app described in "How to set up".` };
  }
  return { ok: true, message: `Connected: ${vendor} issued an access token for these credentials. ${NOT_YET_WIRED}` };
}

function zoomRequest(): TokenRequest {
  const basic = Buffer.from(`${readEnv('ZOOM_CLIENT_ID')}:${readEnv('ZOOM_CLIENT_SECRET')}`).toString('base64');
  const query = new URLSearchParams({ grant_type: 'account_credentials', account_id: readEnv('ZOOM_ACCOUNT_ID') });
  return {
    url: `https://zoom.us/oauth/token?${query.toString()}`,
    headers: { authorization: `Basic ${basic}`, 'content-type': FORM },
    body: '',
  };
}

function teamsRequest(): TokenRequest {
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

/** Returns null when the private key cannot be used to sign. */
function meetRequest(): TokenRequest | null {
  // .env files usually hold the PEM on one line with literal "\n" sequences,
  // exactly as it appears in Google's JSON key file.
  const privateKey = readEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: readEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    sub: readEnv('GOOGLE_IMPERSONATED_USER'),
    scope: GOOGLE_MEET_SCOPE,
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

async function testHosted(): Promise<ConnectionResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // Name only: driver errors can embed connection details.
    logger.error({ errorName: (err as { name?: string } | null)?.name ?? 'Error' }, 'Hosted room test: database unreachable');
    return { ok: false, message: 'The hosted room cannot reach its database. Check DATABASE_URL on the server and that the database is running.' };
  }

  let origin: URL;
  try {
    origin = new URL(config.webOrigin);
  } catch {
    return { ok: false, message: 'WEB_ORIGIN in server/.env is not a valid URL, so candidate interview links would be broken. Set it to the public address of the app and restart the server.' };
  }
  if (config.nodeEnv === 'production' && origin.protocol !== 'https:') {
    return { ok: false, message: 'WEB_ORIGIN must use https in production: browsers block camera and microphone access on plain http, so candidates could not join the room.' };
  }
  return { ok: true, message: `Hosted room ready: the database is reachable and interview links will use ${origin.origin}. No vendor account is needed.` };
}

export async function testMeetingConnection(id: MeetingAdapterId): Promise<ConnectionResult> {
  switch (id) {
    case 'hosted':
      return testHosted();
    case 'zoom':
      return requestToken('zoom', zoomRequest());
    case 'teams':
      return requestToken('teams', teamsRequest());
    case 'meet': {
      const req = meetRequest();
      if (!req) {
        return { ok: false, message: 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY could not be read as a private key. Paste the private_key value from the JSON key file (keeping its \\n sequences), then restart the server.' };
      }
      return requestToken('meet', req);
    }
    default: {
      const unreachable: never = id;
      throw new Error(`Unhandled meeting adapter: ${String(unreachable)}`);
    }
  }
}
