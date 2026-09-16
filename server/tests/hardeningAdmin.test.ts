import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { webhookUrlProblem } from '../src/services/webhookUrl.js';

/**
 * The admin console's two unguarded writes, pinned: the tenant policy (the
 * candidate-facing consent notice and the safeguard switches) and outbound
 * webhooks (the server making requests to an address an admin typed).
 */

const app = createApp();
let adminToken = '';
let tenantId = '';
const auth = () => ({ Authorization: `Bearer ${adminToken}` });

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@policy.local', password: 'fixture-admin-passphrase', name: 'Policy Admin', tenantName: 'Policy Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;
});

const putPolicy = (policy: unknown) => request(app).put('/api/admin/policy').set(auth()).send({ policy });
const getPolicy = async () => (await request(app).get('/api/admin/policy').set(auth())).body.policy;

describe('changing the tenant policy', () => {
  it('refuses a key it does not know', async () => {
    expect((await putPolicy({ humanReviewOff: true })).status).toBe(400);
  });

  it('refuses a blank disclosure, which would show the candidate an empty notice', async () => {
    expect((await putPolicy({ disclosureText: '   ' })).status).toBe(400);
  });

  it('refuses a body with no policy at all instead of wiping every safeguard', async () => {
    expect((await request(app).put('/api/admin/policy').set(auth()).send({})).status).toBe(400);
  });

  it('merges a change into what was there rather than replacing it', async () => {
    await putPolicy({ proctoringEnabled: true });
    await putPolicy({ candidateFeedbackEnabled: true });

    const policy = await getPolicy();
    expect(policy).toMatchObject({ proctoringEnabled: true, candidateFeedbackEnabled: true });
  });

  it('records who changed it, with before and after', async () => {
    await putPolicy({ requireHumanReview: true });

    const event = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'tenant.policy.updated' }, orderBy: { createdAt: 'desc' } });
    expect(event?.afterJson ?? '').toContain('requireHumanReview');
  });
});

describe('where a webhook may point', () => {
  const create = (url: string) => request(app).post('/api/admin/webhooks').set(auth()).send({ url, events: '*' });

  it('refuses a link-local metadata address', async () => {
    expect((await create('http://169.254.169.254/latest/meta-data')).status).toBe(400);
  });

  it('refuses loopback by name', async () => {
    expect((await create('http://localhost:4000/api/health')).status).toBe(400);
  });

  it('refuses loopback by address', async () => {
    expect((await create('https://127.0.0.1/hook')).status).toBe(400);
  });

  it('refuses a private network address', async () => {
    expect((await create('https://10.0.0.5/hook')).status).toBe(400);
  });

  it('refuses a scheme that is not http(s)', async () => {
    expect((await create('ftp://hooks.example.com/hook')).status).toBe(400);
  });

  it('accepts a public https address and records the creation', async () => {
    const res = await create('https://hooks.example.com/questor');

    const event = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'webhook.created' } });
    expect([res.status, event?.entityId]).toEqual([201, res.body.webhook.id]);
  });

  it('lets an admin remove a webhook', async () => {
    const created = await create('https://hooks.example.com/to-remove');

    const res = await request(app).delete(`/api/admin/webhooks/${created.body.webhook.id}`).set(auth());

    expect(res.status).toBe(200);
  });

  it('insists on https in production', () => {
    expect(webhookUrlProblem('http://hooks.example.com/x', 'production')).not.toBeNull();
  });

  it('catches an IPv4 address hidden inside IPv6', () => {
    expect(webhookUrlProblem('https://[::ffff:127.0.0.1]/x', 'production')).not.toBeNull();
  });

  it('refuses credentials embedded in the URL', () => {
    expect(webhookUrlProblem('https://user:secret@hooks.example.com/x', 'production')).not.toBeNull();
  });
});

describe('the build an admin is looking at', () => {
  it('is reported on the admin console alongside the health check', async () => {
    const res = await request(app).get('/api/admin/providers').set(auth());

    expect(typeof res.body.build?.commit).toBe('string');
  });
});

describe('sign-ins in the audit trail', () => {
  it('records a successful login', async () => {
    await request(app).post('/api/auth/login').send({ email: 'admin@policy.local', password: 'fixture-admin-passphrase' });

    const event = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'auth.login' } });
    expect(event).not.toBeNull();
  });

  it('records a failed attempt on a known account', async () => {
    await request(app).post('/api/auth/login').send({ email: 'admin@policy.local', password: 'wrong-passphrase-entirely' });

    const event = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'auth.login_failed' } });
    expect(event).not.toBeNull();
  });
});

describe('the operations view', () => {
  it('reports jobs, webhook counts and model failures in one place', async () => {
    const res = await request(app).get('/api/admin/ops').set(auth());

    expect([res.status, Array.isArray(res.body.jobs), typeof res.body.webhooks.pending, typeof res.body.model.last24h.calls]).toEqual([200, true, 'number', 'number']);
  });

  it('is not for recruiters', async () => {
    const recruiter = await prisma.user.create({ data: { tenantId, email: 'rec@policy.local', name: 'Rec', passwordHash: 'x', role: 'recruiter' } });
    const { signToken } = await import('../src/services/auth.js');
    const token = signToken({ userId: recruiter.id, tenantId, role: 'recruiter', email: recruiter.email });

    const res = await request(app).get('/api/admin/ops').set({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(403);
  });
});
