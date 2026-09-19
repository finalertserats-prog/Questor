import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { generateKeyPairSync } from 'node:crypto';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { meetingCapability } from '../src/providers/meeting/index.js';
import { config } from '../src/config.js';

// Connection tests for meeting adapters. Every outbound call is a mocked fetch:
// a test that reached Zoom or Microsoft would need real credentials and would
// fail (or bill) on whichever machine happened to have them.

const app = createApp();

// Obvious markers so an echo anywhere in a response or audit row is detectable.
const ZOOM_SECRET = 'zoom-secret-MARKER-do-not-echo';
const MS_SECRET = 'graph-secret-MARKER-do-not-echo';
const VENDOR_TOKEN = 'vendor-access-token-MARKER';

const PASS_A = 'connector-admin-a-long-pass';
const PASS_B = 'connector-admin-b-long-pass';
const PASS_R = 'connector-recruiter-long-pass';

let adminA = '';
let adminB = '';
let recruiterA = '';
let tenantA = '';
let tenantB = '';

const MEETING_ENV_NAMES = [
  'ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET',
  'MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GOOGLE_IMPERSONATED_USER',
];

const testAs = (token: string, adapterId: string) =>
  request(app).post(`/api/admin/connectors/meeting/${adapterId}/test`).set('Authorization', `Bearer ${token}`);

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function configureZoom() {
  vi.stubEnv('ZOOM_ACCOUNT_ID', 'acct-123');
  vi.stubEnv('ZOOM_CLIENT_ID', 'client-123');
  vi.stubEnv('ZOOM_CLIENT_SECRET', ZOOM_SECRET);
}

beforeAll(async () => {
  await wipe();
  // The meeting apps are the deployment's, so only the operator (the signup
  // approver) may test them. Admin A is the operator here; admin B is not.
  config.signupApproverEmail = 'admin@conn-a.local';
  const a = await request(app).post('/api/auth/register').send({ email: 'admin@conn-a.local', password: PASS_A, name: 'Admin A', tenantName: 'Conn A' });
  expect(a.status).toBe(201);
  adminA = a.body.token;
  const b = await request(app).post('/api/auth/register').send({ email: 'admin@conn-b.local', password: PASS_B, name: 'Admin B', tenantName: 'Conn B' });
  expect(b.status).toBe(201);
  adminB = b.body.token;

  const r = await request(app).post('/api/admin/users').set('Authorization', `Bearer ${adminA}`)
    .send({ email: 'recruiter@conn-a.local', password: PASS_R, name: 'Rec A', role: 'recruiter' });
  expect(r.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({ email: 'recruiter@conn-a.local', password: PASS_R });
  recruiterA = login.body.token;

  tenantA = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@conn-a.local' } })).tenantId;
  tenantB = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@conn-b.local' } })).tenantId;
});

beforeEach(() => {
  // Start every case from "nothing configured", whatever the developer's .env holds.
  for (const name of MEETING_ENV_NAMES) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/admin/connectors/meeting/:adapterId/test — access', () => {
  it('rejects an unauthenticated caller', async () => {
    const res = await request(app).post('/api/admin/connectors/meeting/hosted/test');
    expect(res.status).toBe(401);
  });

  it('denies a recruiter (no admin:manage)', async () => {
    expect((await testAs(recruiterA, 'hosted')).status).toBe(403);
  });

  it('denies a tenant admin who is not the deployment operator', async () => {
    expect((await testAs(adminB, 'hosted')).status).toBe(403);
  });

  it('denies every admin when no operator is configured', async () => {
    config.signupApproverEmail = '';
    try {
      expect((await testAs(adminA, 'hosted')).status).toBe(403);
    } finally {
      config.signupApproverEmail = 'admin@conn-a.local';
    }
  });

  it('matches the operator address regardless of case', async () => {
    config.signupApproverEmail = ' Admin@Conn-A.local ';
    try {
      expect((await testAs(adminA, 'hosted')).status).toBe(200);
    } finally {
      config.signupApproverEmail = 'admin@conn-a.local';
    }
  });

  it('returns 404 for an unknown adapter id', async () => {
    expect((await testAs(adminA, 'webex')).status).toBe(404);
  });

  it('returns 409 with a setup hint naming the missing variables when unconfigured', async () => {
    const res = await testAs(adminA, 'zoom');
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain('ZOOM_CLIENT_SECRET');
  });
});

describe('connection tests call the lightest authenticated vendor endpoint', () => {
  it('hosted room passes without any outbound call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await testAs(adminA, 'hosted');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('zoom obtains a Server-to-Server OAuth token', async () => {
    configureZoom();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: VENDOR_TOKEN, expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await testAs(adminA, 'zoom');

    expect(res.body.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://zoom.us/oauth/token');
  });

  it('refuses to follow vendor redirects, so the secret-bearing body cannot be re-posted elsewhere', async () => {
    configureZoom();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: VENDOR_TOKEN }));
    vi.stubGlobal('fetch', fetchMock);
    await testAs(adminA, 'zoom');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('zoom success response echoes neither the client secret nor the vendor token', async () => {
    configureZoom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { access_token: VENDOR_TOKEN })));
    const res = await testAs(adminA, 'zoom');
    const raw = JSON.stringify(res.body);
    expect(raw.includes(ZOOM_SECRET) || raw.includes(VENDOR_TOKEN)).toBe(false);
  });

  it('zoom rejection returns a friendly message without the raw vendor body', async () => {
    configureZoom();
    const vendorBody = { reason: `Invalid client_secret ${ZOOM_SECRET}`, token: VENDOR_TOKEN };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, vendorBody)));

    const res = await testAs(adminA, 'zoom');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/MARKER|Invalid client_secret/);
  });

  it('a timed-out vendor call reports a timeout, not a crash', async () => {
    configureZoom();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError')));
    const res = await testAs(adminA, 'zoom');
    expect(res.body).toMatchObject({ ok: false, message: expect.stringMatching(/did not respond/i) });
  });

  it('teams obtains a Microsoft Graph client-credentials token for the configured tenant', async () => {
    vi.stubEnv('MS_GRAPH_TENANT_ID', 'contoso-tenant-guid');
    vi.stubEnv('MS_GRAPH_CLIENT_ID', 'graph-client-id');
    vi.stubEnv('MS_GRAPH_CLIENT_SECRET', MS_SECRET);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: VENDOR_TOKEN }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await testAs(adminA, 'teams');

    expect(res.body.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://login.microsoftonline.com/contoso-tenant-guid/oauth2/v2.0/token');
  });

  it('meet exchanges a signed service-account JWT (escaped newlines accepted) at Google', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'questor@project.iam.gserviceaccount.com');
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', privateKey.replace(/\n/g, '\\n'));
    vi.stubEnv('GOOGLE_IMPERSONATED_USER', 'hr@yourco.com');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: VENDOR_TOKEN }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await testAs(adminA, 'meet');

    expect(res.body.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/token');
  });
});

describe('connection tests are audited without secrets', () => {
  it('writes an audit event with adapter id and outcome only', async () => {
    configureZoom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { token: VENDOR_TOKEN })));
    await testAs(adminA, 'zoom');

    const event = await prisma.auditEvent.findFirst({
      where: { tenantId: tenantA, action: 'connector.tested', entityId: 'meeting:zoom' },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.parse(event?.afterJson ?? '{}')).toEqual({ adapterId: 'zoom', outcome: 'failed' });
  });

  it('never stores the secret in the audit trail', async () => {
    configureZoom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { access_token: VENDOR_TOKEN })));
    await testAs(adminA, 'zoom');
    const rows = await prisma.auditEvent.findMany({ where: { action: 'connector.tested' } });
    expect(JSON.stringify(rows)).not.toContain('MARKER');
  });

  it("a refused non-operator's attempt writes nothing to any tenant's trail", async () => {
    const before = await prisma.auditEvent.count({ where: { action: 'connector.tested', tenantId: { in: [tenantA, tenantB] } } });
    await testAs(adminB, 'hosted');
    const after = await prisma.auditEvent.count({ where: { action: 'connector.tested', tenantId: { in: [tenantA, tenantB] } } });
    expect(after).toBe(before);
  });
});

describe('GET /api/admin/providers — meeting status exposes variable names, never values', () => {
  it('marks zoom configured and lists which variables are present', async () => {
    configureZoom();
    const res = await request(app).get('/api/admin/providers').set('Authorization', `Bearer ${adminA}`);
    const zoom = res.body.meeting.find((m: { provider: string }) => m.provider === 'zoom');
    expect({ configured: zoom.configured, env: zoom.env }).toEqual({
      configured: true,
      env: [
        { name: 'ZOOM_ACCOUNT_ID', present: true },
        { name: 'ZOOM_CLIENT_ID', present: true },
        { name: 'ZOOM_CLIENT_SECRET', present: true },
      ],
    });
  });

  it('tells the operator the test buttons are theirs', async () => {
    const res = await request(app).get('/api/admin/providers').set('Authorization', `Bearer ${adminA}`);
    expect(res.body.canTestMeetingConnectors).toBe(true);
  });

  it('tells any other admin they are not', async () => {
    const res = await request(app).get('/api/admin/providers').set('Authorization', `Bearer ${adminB}`);
    expect(res.body.canTestMeetingConnectors).toBe(false);
  });

  it('is not readable by a non-admin at all', async () => {
    configureZoom();

    const res = await request(app).get('/api/admin/providers').set('Authorization', `Bearer ${recruiterA}`);

    expect(res.status).toBe(403);
  });

  it('does not include any credential value in the providers payload', async () => {
    configureZoom();
    const res = await request(app).get('/api/admin/providers').set('Authorization', `Bearer ${adminA}`);
    expect(JSON.stringify(res.body)).not.toContain(ZOOM_SECRET);
  });

  it('reports teams as not configured when its secret is missing', async () => {
    vi.stubEnv('MS_GRAPH_TENANT_ID', 'contoso-tenant-guid');
    vi.stubEnv('MS_GRAPH_CLIENT_ID', 'graph-client-id');
    const res = await request(app).get('/api/admin/providers').set('Authorization', `Bearer ${adminA}`);
    const teams = res.body.meeting.find((m: { provider: string }) => m.provider === 'teams');
    expect(teams.configured).toBe(false);
  });
});

describe('meeting capability keeps configuration detail out of non-admin routes', () => {
  it('omits the variable-presence list unless the caller asked for it', () => {
    expect(meetingCapability('zoom').env).toBeUndefined();
  });

  it('includes it when asked, with names only', () => {
    const env = meetingCapability('zoom', { includeEnv: true }).env;
    expect(env?.every((e) => typeof e.name === 'string' && typeof e.present === 'boolean')).toBe(true);
  });
});
