import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EmailMessage } from '../src/providers/email/index.js';

const sent: EmailMessage[] = [];

vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test',
      configured: true,
      delivers: true,
      send: vi.fn(async (msg: EmailMessage) => {
        sent.push(msg);
        return { status: 'sent', id: `test-${sent.length}` };
      }),
    }),
  };
});

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import { hashSignupDecisionToken, mintSignupDecisionToken } from '../src/services/signup.js';

const app = createApp();
const PASSWORD = 'correct-horse-battery-staple';

async function wipe() {
  await prisma.auditEvent.deleteMany();
  await prisma.signupRequest.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}

async function counts() {
  const [tenants, users, signups] = await Promise.all([
    prisma.tenant.count(),
    prisma.user.count(),
    prisma.signupRequest.count(),
  ]);
  return { tenants, users, signups };
}

function signupBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Priya Applicant',
    email: 'priya@example.com',
    password: PASSWORD,
    mode: 'new-org',
    organisationName: 'Priya Labs',
    ...overrides,
  };
}

function decisionTokenFromOperatorMail() {
  const operator = sent.find((m) => m.to === config.signupApproverEmail);
  const match = operator?.text.match(/\/signup\/decision\/([A-Za-z0-9_-]{24,128})/);
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

async function existingTenant(slug = 'acme') {
  return prisma.tenant.create({ data: { name: 'Acme Hiring', slug } });
}

async function adminAuth() {
  const tenant = await prisma.tenant.create({ data: { name: 'Operator Org', slug: 'operator-org' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'operator@example.com', name: 'Operator', passwordHash: hashPassword(PASSWORD), role: 'admin' },
  });
  return `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email: user.email })}`;
}

beforeEach(async () => {
  sent.length = 0;
  config.signupApproverEmail = 'operator@example.com';
  config.webOrigin = 'https://questor.example';
  await wipe();
});

describe('operator-approved signup', () => {
  it('returns the identical public response for a known and an unknown email', async () => {
    await existingTenant();
    await prisma.user.create({
      data: { tenantId: (await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })).id, email: 'known@example.com', name: 'Known', passwordHash: 'x', role: 'recruiter' },
    });

    const known = await request(app).post('/api/signup').send(signupBody({ email: 'known@example.com' }));
    const unknown = await request(app).post('/api/signup').send(signupBody({ email: 'unknown@example.com' }));

    expect(known.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(known.body).toEqual({ status: 'pending' });
    expect(unknown.body).toEqual({ status: 'pending' });
  });

  it('creates no tenant or user while the request is pending', async () => {
    const before = await counts();

    const res = await request(app).post('/api/signup').send(signupBody());

    expect(res.status).toBe(201);
    expect(await counts()).toEqual({ ...before, signups: before.signups + 1 });
  });

  it('approves a new organisation by creating exactly one tenant and its admin user', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true });
    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'priya@example.com' }, include: { tenant: true } });
    expect(user.role).toBe('admin');
    expect(user.tenant.name).toBe('Priya Labs');
    expect(sent.filter((m) => m.to === 'priya@example.com' && m.subject.includes('ready'))).toHaveLength(1);
  });

  it('approves a join request by creating only the recruiter user in the existing tenant', async () => {
    const tenant = await existingTenant('acme');
    await request(app).post('/api/signup').send(signupBody({ mode: 'join', orgCode: 'acme', organisationName: undefined, email: 'joiner@example.com' }));
    const token = decisionTokenFromOperatorMail();

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(await prisma.tenant.count()).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'joiner@example.com' } });
    expect(user.tenantId).toBe(tenant.id);
    expect(user.role).toBe('recruiter');
  });

  it('handles two simultaneous approvals by creating one user and sending one welcome', async () => {
    await request(app).post('/api/signup').send(signupBody({ email: 'race@example.com' }));
    const token = decisionTokenFromOperatorMail();

    const results = await Promise.all([
      request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' }),
      request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 200]);
    expect(await prisma.user.count({ where: { email: 'race@example.com' } })).toBe(1);
    expect(await prisma.tenant.count()).toBe(1);
    expect(sent.filter((m) => m.to === 'race@example.com' && m.subject.includes('ready'))).toHaveLength(1);
  });

  it('returns 410 for an expired decision token', async () => {
    const token = mintSignupDecisionToken();
    await prisma.signupRequest.create({
      data: {
        name: 'Expired Applicant', email: 'expired@example.com', mode: 'new-org', organisationName: 'Expired Org',
        passwordHash: hashPassword(PASSWORD), decisionTokenHash: hashSignupDecisionToken(token), expiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await request(app).get(`/api/signup/decision/${token}`);

    expect(res.status).toBe(410);
    expect(await prisma.signupRequest.findFirstOrThrow({ where: { email: 'expired@example.com' } })).toHaveProperty('status', 'EXPIRED');
  });

  it('returns 404 for a tampered decision token before any database state is revealed', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    const res = await request(app).get(`/api/signup/decision/${tampered}`);

    expect(res.status).toBe(404);
  });

  it('records a decline without creating an account or organisation', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'decline' });

    expect(res.status).toBe(200);
    expect(await prisma.tenant.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.signupRequest.findFirstOrThrow()).toHaveProperty('status', 'DECLINED');
  });

  it('fails closed with 503 when no approver address is configured', async () => {
    config.signupApproverEmail = '';

    const res = await request(app).post('/api/signup').send(signupBody());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Signup is temporarily unavailable.');
    expect(await prisma.signupRequest.count()).toBe(0);
  });

  it('lets an authenticated admin list and approve pending requests', async () => {
    const auth = await adminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'admin-approve@example.com' }));
    const requestRow = await prisma.signupRequest.findFirstOrThrow({ where: { email: 'admin-approve@example.com' } });

    const listed = await request(app).get('/api/admin/signups?status=pending').set('Authorization', auth);
    expect(listed.status).toBe(200);
    expect(listed.body.signups).toHaveLength(1);

    const approved = await request(app).post(`/api/admin/signups/${requestRow.id}/approve`).set('Authorization', auth);
    expect(approved.status).toBe(200);
    expect(await prisma.user.count({ where: { email: 'admin-approve@example.com' } })).toBe(1);
  });
});