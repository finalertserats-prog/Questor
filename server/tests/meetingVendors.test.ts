import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { vendorFor } from '../src/providers/meeting/roundMeetings.js';
import { clearTokenCache } from '../src/providers/meeting/tokenCache.js';
import { MeetingProviderError } from '../src/providers/meeting/vendorHttp.js';
import type { MeetingDetails, MeetingVendor } from '../src/providers/meeting/types.js';

// Real meeting creation against Teams, Zoom and Google Calendar — every call a
// mocked fetch. These pin the request each vendor documents (URL, method, auth
// header, body), the token cache, and how vendor failures reach a recruiter.

const SECRET = 'vendor-secret-MARKER-do-not-echo';
const TOKEN = 'vendor-access-token-MARKER';

const DETAILS: MeetingDetails = {
  title: 'Gold interview (Questor)',
  description: 'Candidate page: https://hire.example.com/candidates/c1',
  startsAt: new Date('2026-10-08T09:00:00.000Z'),
  durationMinutes: 45,
  timeZone: 'Asia/Kolkata',
  requestId: 'round-1',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const empty = (status: number) => new Response(null, { status });
const tokenResponse = () => json(200, { access_token: TOKEN, expires_in: 3600 });

type FetchArgs = [string, RequestInit];
function mockFetch(...responses: Array<Response | Error>) {
  const fn = vi.fn<(...args: FetchArgs) => Promise<Response>>();
  for (const r of responses) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r);
    else fn.mockResolvedValueOnce(r);
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}
const call = (fn: ReturnType<typeof mockFetch>, index: number) => {
  const [url, init] = fn.mock.calls[index];
  const headers = (init.headers ?? {}) as Record<string, string>;
  const isJson = headers['content-type'] === 'application/json';
  return { url: String(url), init, headers, body: isJson && init.body ? JSON.parse(String(init.body)) : undefined };
};

function vendor(id: 'teams' | 'zoom' | 'meet'): MeetingVendor {
  const v = vendorFor(id);
  if (!v) throw new Error(`no vendor ${id}`);
  return v;
}

function configureZoom() {
  vi.stubEnv('ZOOM_ACCOUNT_ID', 'acct-1');
  vi.stubEnv('ZOOM_CLIENT_ID', 'zoom-client');
  vi.stubEnv('ZOOM_CLIENT_SECRET', SECRET);
  vi.stubEnv('ZOOM_HOST_USER_ID', 'host@example.com');
}
function configureTeams() {
  vi.stubEnv('MS_GRAPH_TENANT_ID', 'tenant-guid');
  vi.stubEnv('MS_GRAPH_CLIENT_ID', 'graph-client');
  vi.stubEnv('MS_GRAPH_CLIENT_SECRET', SECRET);
  vi.stubEnv('MS_GRAPH_ORGANIZER_USER_ID', 'organiser-guid');
}
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
function configureMeet() {
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'questor@project.iam.gserviceaccount.com');
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', privateKey.replace(/\n/g, '\\n'));
  vi.stubEnv('GOOGLE_IMPERSONATED_USER', 'hr@example.com');
}

beforeEach(() => {
  clearTokenCache();
  for (const name of [
    'ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID',
    'MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET', 'MS_GRAPH_ORGANIZER_USER_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GOOGLE_IMPERSONATED_USER',
  ]) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Zoom (Server-to-Server OAuth)', () => {
  it('is not configured without a host user', () => {
    vi.stubEnv('ZOOM_ACCOUNT_ID', 'acct-1');
    vi.stubEnv('ZOOM_CLIENT_ID', 'zoom-client');
    vi.stubEnv('ZOOM_CLIENT_SECRET', SECRET);
    expect(vendor('zoom').isConfigured()).toBe(false);
  });

  it('requests an account_credentials token with Basic auth', async () => {
    configureZoom();
    const fetchMock = mockFetch(tokenResponse(), json(201, { id: 123456789, join_url: 'https://zoom.us/j/123456789' }));
    await vendor('zoom').create(DETAILS);
    const token = call(fetchMock, 0);
    expect({ url: token.url, method: token.init.method, auth: token.headers.authorization }).toEqual({
      url: 'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=acct-1',
      method: 'POST',
      auth: `Basic ${Buffer.from(`zoom-client:${SECRET}`).toString('base64')}`,
    });
  });

  it('creates a scheduled meeting for the host user with the bearer token', async () => {
    configureZoom();
    const fetchMock = mockFetch(tokenResponse(), json(201, { id: 123456789, join_url: 'https://zoom.us/j/123456789' }));
    await vendor('zoom').create(DETAILS);
    const create = call(fetchMock, 1);
    expect({ url: create.url, method: create.init.method, auth: create.headers.authorization, body: create.body }).toEqual({
      url: 'https://api.zoom.us/v2/users/host%40example.com/meetings',
      method: 'POST',
      auth: `Bearer ${TOKEN}`,
      body: expect.objectContaining({ topic: DETAILS.title, type: 2, start_time: '2026-10-08T09:00:00Z', duration: 45, timezone: 'Asia/Kolkata' }),
    });
  });

  it('keeps the candidate-page link out of the agenda participants can read', async () => {
    configureZoom();
    const fetchMock = mockFetch(tokenResponse(), json(201, { id: 1, join_url: 'https://zoom.us/j/1' }));
    await vendor('zoom').create(DETAILS);
    expect(JSON.stringify(call(fetchMock, 1).body)).not.toContain('/candidates/');
  });

  it('returns the meeting id and join URL', async () => {
    configureZoom();
    mockFetch(tokenResponse(), json(201, { id: 123456789, join_url: 'https://zoom.us/j/123456789' }));
    expect(await vendor('zoom').create(DETAILS)).toEqual({ externalId: '123456789', joinUrl: 'https://zoom.us/j/123456789' });
  });

  it('reuses a cached token for the next call', async () => {
    configureZoom();
    const fetchMock = mockFetch(
      tokenResponse(),
      json(201, { id: 1, join_url: 'https://zoom.us/j/1' }),
      json(201, { id: 2, join_url: 'https://zoom.us/j/2' }),
    );
    await vendor('zoom').create(DETAILS);
    await vendor('zoom').create(DETAILS);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth/token'))).toHaveLength(1);
  });

  it('fetches a new token once the cached one has expired', async () => {
    configureZoom();
    const fetchMock = mockFetch(
      json(200, { access_token: TOKEN, expires_in: 1 }),
      json(201, { id: 1, join_url: 'https://zoom.us/j/1' }),
      tokenResponse(),
      json(201, { id: 2, join_url: 'https://zoom.us/j/2' }),
    );
    await vendor('zoom').create(DETAILS);
    await vendor('zoom').create(DETAILS);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('oauth/token'))).toHaveLength(2);
  });

  it('updates the start time and duration with PATCH', async () => {
    configureZoom();
    const fetchMock = mockFetch(tokenResponse(), empty(204));
    await vendor('zoom').update('123456789', { ...DETAILS, startsAt: new Date('2026-10-09T10:30:00.000Z'), durationMinutes: 30 });
    const patch = call(fetchMock, 1);
    expect({ url: patch.url, method: patch.init.method, body: patch.body }).toEqual({
      url: 'https://api.zoom.us/v2/meetings/123456789',
      method: 'PATCH',
      body: expect.objectContaining({ start_time: '2026-10-09T10:30:00Z', duration: 30, timezone: 'Asia/Kolkata' }),
    });
  });

  it('deletes the meeting on cancel', async () => {
    configureZoom();
    const fetchMock = mockFetch(tokenResponse(), empty(204));
    await vendor('zoom').cancel('123456789');
    expect({ url: call(fetchMock, 1).url, method: call(fetchMock, 1).init.method }).toEqual({ url: 'https://api.zoom.us/v2/meetings/123456789', method: 'DELETE' });
  });

  it('treats a meeting that is already gone as cancelled', async () => {
    configureZoom();
    mockFetch(tokenResponse(), json(404, { code: 3001, message: 'Meeting does not exist' }));
    await expect(vendor('zoom').cancel('123456789')).resolves.toBeUndefined();
  });

  it('does not retry a failed create, so a meeting is never booked twice', async () => {
    configureZoom();
    const fetchMock = mockFetch(tokenResponse(), json(503, {}), json(201, { id: 9, join_url: 'https://zoom.us/j/9' }));
    await expect(vendor('zoom').create(DETAILS)).rejects.toBeInstanceOf(MeetingProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a delete after a server error', async () => {
    configureZoom();
    const fetchMock = mockFetch(tokenResponse(), json(503, {}), empty(204));
    await vendor('zoom').cancel('123456789');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('maps a permission failure to a message an admin can act on, without the vendor body', async () => {
    configureZoom();
    mockFetch(tokenResponse(), json(403, { message: `scope missing ${SECRET}` }));
    const error = await vendor('zoom').create(DETAILS).catch((e: unknown) => e);
    expect((error as MeetingProviderError).userMessage).toMatch(/^Zoom refused permission[^]*Admin/);
  });

  it('never puts the secret or token in the error it raises', async () => {
    configureZoom();
    mockFetch(tokenResponse(), json(401, { message: `bad token ${TOKEN}` }));
    const error = await vendor('zoom').create(DETAILS).catch((e: unknown) => e);
    expect(JSON.stringify({ message: (error as Error).message, user: (error as MeetingProviderError).userMessage })).not.toContain('MARKER');
  });

  it('reports a timeout as a timeout', async () => {
    configureZoom();
    mockFetch(tokenResponse(), new DOMException('The operation timed out.', 'TimeoutError'));
    const error = await vendor('zoom').create(DETAILS).catch((e: unknown) => e);
    expect((error as MeetingProviderError).userMessage).toMatch(/did not respond/);
  });

  it('refuses a join URL that is not https', async () => {
    configureZoom();
    mockFetch(tokenResponse(), json(201, { id: 1, join_url: 'javascript:alert(1)' }));
    await expect(vendor('zoom').create(DETAILS)).rejects.toBeInstanceOf(MeetingProviderError);
  });
});

describe('Microsoft Teams (Graph, app-only)', () => {
  const event = { id: 'AAMkAD-event', onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' } };

  it('requests a client-credentials token for the Graph default scope', async () => {
    configureTeams();
    const fetchMock = mockFetch(tokenResponse(), json(201, event));
    await vendor('teams').create(DETAILS);
    const token = call(fetchMock, 0);
    const form = new URLSearchParams(String(token.init.body));
    expect({ url: token.url, grant: form.get('grant_type'), scope: form.get('scope'), client: form.get('client_id') }).toEqual({
      url: 'https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token',
      grant: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
      client: 'graph-client',
    });
  });

  it("creates an online-meeting event in the organiser's calendar", async () => {
    configureTeams();
    const fetchMock = mockFetch(tokenResponse(), json(201, event));
    await vendor('teams').create(DETAILS);
    const create = call(fetchMock, 1);
    expect({ url: create.url, method: create.init.method, auth: create.headers.authorization, body: create.body }).toEqual({
      url: 'https://graph.microsoft.com/v1.0/users/organiser-guid/events',
      method: 'POST',
      auth: `Bearer ${TOKEN}`,
      body: expect.objectContaining({
        subject: DETAILS.title,
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        // Graph reads dateTime as the wall clock in timeZone: 09:00 UTC is 14:30 in Kolkata.
        start: { dateTime: '2026-10-08T14:30:00', timeZone: 'Asia/Kolkata' },
        end: { dateTime: '2026-10-08T15:15:00', timeZone: 'Asia/Kolkata' },
      }),
    });
  });

  it('returns the event id and Teams join URL', async () => {
    configureTeams();
    mockFetch(tokenResponse(), json(201, event));
    expect(await vendor('teams').create(DETAILS)).toEqual({ externalId: 'AAMkAD-event', joinUrl: event.onlineMeeting.joinUrl });
  });

  it('reads the event back when Graph has not filled in the join URL yet', async () => {
    configureTeams();
    const fetchMock = mockFetch(tokenResponse(), json(201, { id: 'AAMkAD-event', onlineMeeting: null }), json(200, event));
    const created = await vendor('teams').create(DETAILS);
    expect({ joinUrl: created.joinUrl, readBack: call(fetchMock, 2).init.method }).toEqual({ joinUrl: event.onlineMeeting.joinUrl, readBack: 'GET' });
  });

  it('removes the event and fails when no join URL ever arrives', async () => {
    configureTeams();
    const fetchMock = mockFetch(tokenResponse(), json(201, { id: 'AAMkAD-event' }), json(200, { id: 'AAMkAD-event' }), empty(204));
    await expect(vendor('teams').create(DETAILS)).rejects.toBeInstanceOf(MeetingProviderError);
    expect(call(fetchMock, 3).init.method).toBe('DELETE');
  });

  it('patches start and end on reschedule', async () => {
    configureTeams();
    const fetchMock = mockFetch(tokenResponse(), json(200, event));
    await vendor('teams').update('AAMkAD-event', { ...DETAILS, startsAt: new Date('2026-10-09T10:00:00.000Z'), durationMinutes: 60 });
    const patch = call(fetchMock, 1);
    expect({ url: patch.url, method: patch.init.method, body: patch.body }).toEqual({
      url: 'https://graph.microsoft.com/v1.0/users/organiser-guid/events/AAMkAD-event',
      method: 'PATCH',
      body: { start: { dateTime: '2026-10-09T15:30:00', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2026-10-09T16:30:00', timeZone: 'Asia/Kolkata' } },
    });
  });

  it('deletes the event on cancel', async () => {
    configureTeams();
    const fetchMock = mockFetch(tokenResponse(), empty(204));
    await vendor('teams').cancel('AAMkAD-event');
    expect({ url: call(fetchMock, 1).url, method: call(fetchMock, 1).init.method })
      .toEqual({ url: 'https://graph.microsoft.com/v1.0/users/organiser-guid/events/AAMkAD-event', method: 'DELETE' });
  });

  it('names the organiser variable when Graph cannot find that user', async () => {
    configureTeams();
    mockFetch(tokenResponse(), json(404, { error: { code: 'ErrorItemNotFound' } }));
    const error = await vendor('teams').create(DETAILS).catch((e: unknown) => e);
    expect((error as MeetingProviderError).userMessage).toContain('MS_GRAPH_ORGANIZER_USER_ID');
  });

  it('drops a token Graph rejects, so the next call fetches a fresh one', async () => {
    configureTeams();
    const fetchMock = mockFetch(tokenResponse(), json(401, {}), tokenResponse(), json(201, event));
    await vendor('teams').create(DETAILS).catch(() => undefined);
    await vendor('teams').create(DETAILS);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('login.microsoftonline.com'))).toHaveLength(2);
  });

  it('explains a token-endpoint rejection as a credentials problem', async () => {
    configureTeams();
    mockFetch(json(401, { error: 'invalid_client', error_description: SECRET }));
    const error = await vendor('teams').create(DETAILS).catch((e: unknown) => e);
    expect((error as MeetingProviderError).userMessage).toMatch(/did not accept Questor's credentials/);
  });
});

describe('Google Meet (Calendar API, service account)', () => {
  const event = {
    id: 'evt123',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    conferenceData: { createRequest: { status: { statusCode: 'success' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }] },
  };

  it('exchanges a JWT signed with the service-account key, impersonating the subject user', async () => {
    configureMeet();
    const fetchMock = mockFetch(tokenResponse(), json(200, event));
    await vendor('meet').create(DETAILS);
    const token = call(fetchMock, 0);
    const assertion = new URLSearchParams(String(token.init.body)).get('assertion') ?? '';
    const [header, claims, signature] = assertion.split('.');
    const verified = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'));
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
    expect({ url: token.url, verified, sub: decoded.sub, iss: decoded.iss, scope: decoded.scope }).toEqual({
      url: 'https://oauth2.googleapis.com/token',
      verified: true,
      sub: 'hr@example.com',
      iss: 'questor@project.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/calendar.events',
    });
  });

  it('inserts an event with a Meet conference create request', async () => {
    configureMeet();
    const fetchMock = mockFetch(tokenResponse(), json(200, event));
    await vendor('meet').create(DETAILS);
    const insert = call(fetchMock, 1);
    expect({ url: insert.url, method: insert.init.method, auth: insert.headers.authorization, body: insert.body }).toEqual({
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=none',
      method: 'POST',
      auth: `Bearer ${TOKEN}`,
      body: expect.objectContaining({
        summary: DETAILS.title,
        start: { dateTime: '2026-10-08T09:00:00.000Z', timeZone: 'Asia/Kolkata' },
        end: { dateTime: '2026-10-08T09:45:00.000Z', timeZone: 'Asia/Kolkata' },
        conferenceData: { createRequest: { requestId: 'round-1', conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      }),
    });
  });

  it('returns the event id and Meet link', async () => {
    configureMeet();
    mockFetch(tokenResponse(), json(200, event));
    expect(await vendor('meet').create(DETAILS)).toEqual({ externalId: 'evt123', joinUrl: 'https://meet.google.com/abc-defg-hij' });
  });

  it('reads the event back while the conference is still pending', async () => {
    configureMeet();
    const pending = { id: 'evt123', conferenceData: { createRequest: { status: { statusCode: 'pending' } } } };
    const fetchMock = mockFetch(tokenResponse(), json(200, pending), json(200, event));
    const created = await vendor('meet').create(DETAILS);
    expect({ joinUrl: created.joinUrl, readBack: call(fetchMock, 2).url }).toEqual({
      joinUrl: 'https://meet.google.com/abc-defg-hij',
      readBack: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/evt123',
    });
  });

  it('patches the event times on reschedule', async () => {
    configureMeet();
    const fetchMock = mockFetch(tokenResponse(), json(200, event));
    await vendor('meet').update('evt123', { ...DETAILS, startsAt: new Date('2026-10-09T10:00:00.000Z'), durationMinutes: 30 });
    const patch = call(fetchMock, 1);
    expect({ url: patch.url, method: patch.init.method, body: patch.body }).toEqual({
      url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/evt123?sendUpdates=none',
      method: 'PATCH',
      body: { start: { dateTime: '2026-10-09T10:00:00.000Z', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2026-10-09T10:30:00.000Z', timeZone: 'Asia/Kolkata' } },
    });
  });

  it('treats an event that is already deleted (410) as cancelled', async () => {
    configureMeet();
    const fetchMock = mockFetch(tokenResponse(), json(410, {}));
    await vendor('meet').cancel('evt123');
    expect(call(fetchMock, 1).init.method).toBe('DELETE');
  });

  it('reports an unusable private key without calling Google', async () => {
    configureMeet();
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'not-a-key');
    const fetchMock = mockFetch();
    const error = await vendor('meet').create(DETAILS).catch((e: unknown) => e);
    expect({ message: (error as MeetingProviderError).userMessage, calls: fetchMock.mock.calls.length })
      .toEqual({ message: expect.stringContaining('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'), calls: 0 });
  });

  it('maps rate limiting to a try-again message', async () => {
    configureMeet();
    mockFetch(tokenResponse(), json(429, {}));
    const error = await vendor('meet').create(DETAILS).catch((e: unknown) => e);
    expect((error as MeetingProviderError).userMessage).toMatch(/rate-limiting/);
  });
});

describe('manual provider', () => {
  it('has no vendor behind it', () => {
    expect(vendorFor('manual')).toBeNull();
  });
});
