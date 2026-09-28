import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import type { MeetingAdapterId } from './connectorEnv.js';
import { meetTokenRequest, teamsTokenRequest, UNUSABLE_GOOGLE_KEY, zoomTokenRequest, type TokenRequest } from './tokens.js';

// "Test connection" for meeting adapters: the lightest call that proves the
// credentials authenticate — obtaining an OAuth token — and nothing more. No
// meeting is created, no user is contacted.
//
// Nothing a vendor sends back is returned or logged beyond the HTTP status.
// Token-endpoint error bodies can quote the client id, and success bodies carry
// a live access token; both are discarded here so no caller can leak them.

export const VENDOR_TIMEOUT_MS = 8_000;

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

// Said on success so a green test is not mistaken for "interviews now run in
// Zoom": the AI interview stays in the hosted room; vendors create the links
// for human rounds.
const NOT_YET_WIRED = 'AI interviews keep using the hosted Questor room; this connector creates meeting links for human interview rounds once it is selected and its organiser is set.';

const REJECTION_HINT: Readonly<Record<VendorAdapterId, string>> = {
  zoom: 'Zoom rejected these credentials. Check ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET, make sure the Server-to-Server OAuth app is activated, then restart the server.',
  teams: 'Microsoft rejected these credentials. Check MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID and MS_GRAPH_CLIENT_SECRET (use the secret\'s Value, not its ID, and check it has not expired), then restart the server.',
  meet: 'Google rejected the service account. Check the key, that domain-wide delegation grants the Calendar events scope to this service account\'s client ID, and that GOOGLE_IMPERSONATED_USER is a user in your Workspace domain, then restart the server.',
};


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
      // A 307/308 would re-send this body (client secret / signed assertion)
      // to wherever the redirect points. Token endpoints never redirect.
      redirect: 'error',
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
    // Discard the unread error body so the socket is released now, not at GC.
    await res.body?.cancel().catch(() => undefined);
    logger.warn({ adapter, status: res.status }, 'Meeting connector test: vendor rejected the request');
    return { ok: false, message: rejectionMessage(adapter, res.status) };
  }

  const data = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
  if (typeof data?.access_token !== 'string' || data.access_token === '') {
    return { ok: false, message: `${vendor} answered, but not with an access token. Check that the credentials belong to the kind of app described in "How to set up".` };
  }
  return { ok: true, message: `Connected: ${vendor} issued an access token for these credentials. ${NOT_YET_WIRED}` };
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
      return requestToken('zoom', zoomTokenRequest());
    case 'teams':
      return requestToken('teams', teamsTokenRequest());
    case 'meet': {
      const req = meetTokenRequest();
      if (!req) {
        return { ok: false, message: UNUSABLE_GOOGLE_KEY };
      }
      return requestToken('meet', req);
    }
    default: {
      const unreachable: never = id;
      throw new Error(`Unhandled meeting adapter: ${String(unreachable)}`);
    }
  }
}
