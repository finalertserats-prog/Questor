import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { wipe } from '../src/seed/demoData.js';
import { collectIssues } from '../src/preflight.js';
import { installFakeAts } from './fakeAts.js';

// Each organisation connects its own ATS. The key is write-only; an ATS
// account belongs to one organisation; the deployment's ATS_* variables apply
// only to the tenant ATS_TENANT_ID names.

const app = createApp();

const KEY_A = 'ats-key-A-MARKER-never-echo';
const KEY_A2 = 'ats-key-A2-MARKER-never-echo';
const ENV_KEY = 'ats-env-key-MARKER-never-echo';

const as = (token: string) => ({ Authorization: `Bearer ${token}` });

let adminA = '';
let adminB = '';
let recruiterA = '';
let tenantA = '';

async function register(email: string, tenantName: string): Promise<string> {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'ats-conn-long-password', name: tenantName, tenantName });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

beforeAll(async () => {
  await wipe();
  adminA = await register('admin@ats-a.local', 'ATS A');
  adminB = await register('admin@ats-b.local', 'ATS B');
  const r = await request(app).post('/api/admin/users').set(as(adminA))
    .send({ email: 'recruiter@ats-a.local', password: 'ats-conn-long-password', name: 'Rec A', role: 'recruiter' });
  expect(r.status).toBe(201);
  recruiterA = (await request(app).post('/api/auth/login').send({ email: 'recruiter@ats-a.local', password: 'ats-conn-long-password' })).body.token;
  tenantA = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@ats-a.local' } })).tenantId;
});

beforeEach(async () => {
  config.ats.baseUrl = '';
  config.ats.apiKey = '';
  config.ats.tenantId = '';
  config.ats.provider = 'generic';
  await prisma.candidateAtsLink.deleteMany();
  await prisma.atsRequisitionImport.deleteMany();
  await prisma.atsConnection.deleteMany();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const connect = (token: string, body: Record<string, unknown>) => request(app).put('/api/admin/ats').set(as(token)).send(body);

describe('a tenant admin connects their own ATS', () => {
  it('starts with no connection', async () => {
    const res = await request(app).get('/api/admin/ats').set(as(adminA));
    expect(res.body.connection).toBeNull();
  });

  it('saves a connection and says a key is set', async () => {
    const res = await connect(adminA, { provider: 'generic', baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    expect({ status: res.status, hasApiKey: res.body.connection.hasApiKey, connected: res.body.connection.connected })
      .toEqual({ status: 200, hasApiKey: true, connected: true });
  });

  it('never returns the key', async () => {
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const res = await request(app).get('/api/admin/ats').set(as(adminA));
    expect(JSON.stringify(res.body)).not.toContain('MARKER');
  });

  it('stores the key sealed, not in plaintext', async () => {
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const row = await prisma.atsConnection.findUniqueOrThrow({ where: { tenantId: tenantA } });
    expect(row.apiKeySealed.includes('MARKER') || row.apiKeySealed === '').toBe(false);
  });

  it('keeps the stored key when an edit leaves it blank', async () => {
    const fake = installFakeAts({ 'ats-a2.example.com': {} });
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    await connect(adminA, { baseUrl: 'https://ats-a2.example.com/api', apiKey: '' });
    await request(app).post('/api/admin/ats/test').set(as(adminA));
    expect(fake.calls[0].authorization).toBe(`Bearer ${KEY_A}`);
  });

  it('replaces the key when a new one is entered', async () => {
    const fake = installFakeAts({ 'ats-a.example.com': {} });
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A2 });
    await request(app).post('/api/admin/ats/test').set(as(adminA));
    expect(fake.calls[0].authorization).toBe(`Bearer ${KEY_A2}`);
  });

  it('refuses a recruiter', async () => {
    const res = await connect(recruiterA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    expect(res.status).toBe(403);
  });

  it('refuses an address on this machine', async () => {
    const res = await connect(adminA, { baseUrl: 'http://127.0.0.1:4000/api', apiKey: KEY_A });
    expect(res.status).toBe(400);
  });

  it('refuses an address carrying credentials', async () => {
    const res = await connect(adminA, { baseUrl: 'https://user:pw@ats-a.example.com/api', apiKey: KEY_A });
    expect(res.status).toBe(400);
  });

  it('refuses an unknown provider', async () => {
    const res = await connect(adminA, { provider: 'workday', baseUrl: 'https://ats-a.example.com/api' });
    expect(res.status).toBe(400);
  });

  it('refuses to connect an ATS account another organisation already holds', async () => {
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const res = await connect(adminB, { baseUrl: 'https://ATS-A.example.com/api/', apiKey: 'b-key' });
    expect(res.status).toBe(409);
  });

  it('lets two organisations share a multi-customer ATS host with different accounts', async () => {
    await connect(adminA, { provider: 'greenhouse', baseUrl: 'https://harvest.example.com/v1', accountId: 'acme', apiKey: KEY_A });
    const res = await connect(adminB, { provider: 'greenhouse', baseUrl: 'https://harvest.example.com/v1', accountId: 'globex', apiKey: 'b-key' });
    expect(res.status).toBe(200);
  });

  it('audits the save without the key', async () => {
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const rows = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, action: { startsWith: 'ats.connection' } } });
    expect({ any: rows.length > 0, leaked: JSON.stringify(rows).includes('MARKER') }).toEqual({ any: true, leaked: false });
  });
});

describe('a tenant admin tests their own connection', () => {
  it('calls only their own ATS, with their own key', async () => {
    const fake = installFakeAts({ 'ats-a.example.com': {}, 'ats-b.example.com': {} });
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    await connect(adminB, { baseUrl: 'https://ats-b.example.com/api', apiKey: 'b-key' });

    const res = await request(app).post('/api/admin/ats/test').set(as(adminB));

    expect({ ok: res.body.ok, hosts: fake.hostsCalled() }).toEqual({ ok: true, hosts: ['ats-b.example.com'] });
  });

  it('records the outcome on the connection', async () => {
    installFakeAts({ 'ats-a.example.com': {} });
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const res = await request(app).post('/api/admin/ats/test').set(as(adminA));
    expect(res.body.connection.status).toBe('ok');
  });

  it('reports a rejected key in plain words, without the vendor body', async () => {
    installFakeAts({ 'ats-a.example.com': { failWith: 401 } });
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const res = await request(app).post('/api/admin/ats/test').set(as(adminA));
    expect({ ok: res.body.ok, message: res.body.message }).toEqual({ ok: false, message: expect.stringMatching(/rejected these credentials/) });
  });

  it('answers 409 when the organisation has no connection', async () => {
    const res = await request(app).post('/api/admin/ats/test').set(as(adminA));
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'ATS_NOT_CONNECTED' });
  });

  it('refuses a recruiter', async () => {
    const res = await request(app).post('/api/admin/ats/test').set(as(recruiterA));
    expect(res.status).toBe(403);
  });
});

describe('disconnecting', () => {
  it('turns the connection off and forgets the key', async () => {
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const res = await request(app).delete('/api/admin/ats').set(as(adminA));
    expect({ connected: res.body.connection.connected, hasApiKey: res.body.connection.hasApiKey }).toEqual({ connected: false, hasApiKey: false });
  });

  it('makes imports answer "not connected"', async () => {
    const fake = installFakeAts({ 'ats-a.example.com': { requisitions: { 'REQ-1': { title: 'X', description: 'Y' } } } });
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    await request(app).delete('/api/admin/ats').set(as(adminA));
    const res = await request(app).post('/api/roles').set(as(adminA)).send({ sourceType: 'ats', atsRequisitionId: 'REQ-1', useLlm: false });
    expect({ status: res.status, code: res.body.code, calls: fake.calls.length }).toEqual({ status: 409, code: 'ATS_NOT_CONNECTED', calls: 0 });
  });
});

describe('the deployment ATS variables', () => {
  const ENV_REQ = { 'REQ-9': { title: 'Env Role', description: 'Requirements: SQL and Python for data pipelines.' } };

  it('are ignored when ATS_TENANT_ID is not set', async () => {
    config.ats.baseUrl = 'https://ats-env.example.com/api';
    config.ats.apiKey = ENV_KEY;
    const fake = installFakeAts({ 'ats-env.example.com': { requisitions: ENV_REQ } });
    const res = await request(app).post('/api/roles').set(as(adminA)).send({ sourceType: 'ats', atsRequisitionId: 'REQ-9', useLlm: false });
    expect({ status: res.status, calls: fake.calls.length }).toEqual({ status: 409, calls: 0 });
  });

  it('serve the tenant ATS_TENANT_ID names, with the key from the environment', async () => {
    config.ats.baseUrl = 'https://ats-env.example.com/api';
    config.ats.apiKey = ENV_KEY;
    config.ats.tenantId = tenantA;
    const fake = installFakeAts({ 'ats-env.example.com': { requisitions: ENV_REQ } });
    const res = await request(app).post('/api/roles').set(as(adminA)).send({ sourceType: 'ats', atsRequisitionId: 'REQ-9', useLlm: false });
    expect({ status: res.status, auth: fake.calls[0]?.authorization }).toEqual({ status: 201, auth: `Bearer ${ENV_KEY}` });
  });

  it('do not serve any other tenant', async () => {
    config.ats.baseUrl = 'https://ats-env.example.com/api';
    config.ats.apiKey = ENV_KEY;
    config.ats.tenantId = tenantA;
    const fake = installFakeAts({ 'ats-env.example.com': { requisitions: ENV_REQ } });
    const res = await request(app).post('/api/roles').set(as(adminB)).send({ sourceType: 'ats', atsRequisitionId: 'REQ-9', useLlm: false });
    expect({ status: res.status, calls: fake.calls.length }).toEqual({ status: 409, calls: 0 });
  });

  it('never copy the environment key into the database', async () => {
    config.ats.baseUrl = 'https://ats-env.example.com/api';
    config.ats.apiKey = ENV_KEY;
    config.ats.tenantId = tenantA;
    const res = await request(app).get('/api/admin/ats').set(as(adminA));
    const row = await prisma.atsConnection.findUniqueOrThrow({ where: { tenantId: tenantA } });
    expect({ source: res.body.connection.source, hasApiKey: res.body.connection.hasApiKey, sealed: row.apiKeySealed })
      .toEqual({ source: 'env', hasApiKey: true, sealed: '' });
  });

  it('stop working when the binding is removed', async () => {
    config.ats.baseUrl = 'https://ats-env.example.com/api';
    config.ats.tenantId = tenantA;
    await request(app).get('/api/admin/ats').set(as(adminA));
    config.ats.tenantId = '';
    const res = await request(app).get('/api/admin/ats').set(as(adminA));
    expect(res.body.connection.connected).toBe(false);
  });

  it('draw a startup warning when set without a tenant', () => {
    config.ats.baseUrl = 'https://ats-env.example.com/api';
    expect(collectIssues({}).map((i) => i.code)).toContain('ATS_UNBOUND');
  });
});

describe('GET /api/admin/providers', () => {
  it("reports this organisation's ATS, not the deployment's", async () => {
    await connect(adminA, { baseUrl: 'https://ats-a.example.com/api', apiKey: KEY_A });
    const [a, b] = await Promise.all([
      request(app).get('/api/admin/providers').set(as(adminA)),
      request(app).get('/api/admin/providers').set(as(adminB)),
    ]);
    expect([a.body.ats.configured, b.body.ats.configured]).toEqual([true, false]);
  });
});
