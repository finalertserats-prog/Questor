import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '../src/providers/email/index.js';

vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({ name: 'test', configured: true, delivers: true, send: vi.fn(async (_msg: EmailMessage) => ({ status: 'sent', id: 't' })) }),
  };
});

import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { signToken } from '../src/services/auth.js';
import { decideSignupRequest } from '../src/services/signup.js';
import { reportMissingOperatorAccounts } from '../src/middleware/platformOperator.js';

/**
 * Platform operator standing comes from an email address, so an account for
 * that address is the key. No tenant admin, applicant or self-registration may
 * mint one; only a platform operator may.
 */

const app = createApp();
const RESERVED = 'owner-unclaimed@questor.test';

async function tenantAdmin(email: string) {
  const tenant = await prisma.tenant.create({ data: { name: `${email} org` } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email, name: email, passwordHash: 'x', role: 'admin' } });
  return `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email })}`;
}

async function signupRow(email: string, mode: 'new-org' | 'join', orgSlug: string | null = null) {
  return prisma.signupRequest.create({
    data: { name: 'Applicant', email, mode, organisationName: mode === 'new-org' ? 'Applicant Org' : null, orgSlug, passwordHash: 'x', decisionTokenHash: `h-${Math.random()}`, expiresAt: new Date(Date.now() + 86_400_000) },
  });
}

beforeEach(async () => {
  await prisma.catalogProposal.deleteMany();
  await prisma.catalogRefreshRun.deleteMany();
  await prisma.signupRequest.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: '@questor.test' } } });
  config.platformOperatorEmails = ['owner@questor.test', RESERVED];
});

describe('creating an account for a platform operator address', () => {
  it('is refused to a tenant admin, looking like any taken address', async () => {
    const auth = await tenantAdmin('admin-a@questor.test');
    const res = await request(app).post('/api/admin/users').set('Authorization', auth).send({ email: RESERVED, password: 'long-enough-password', name: 'Me', role: 'admin' });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: 'Email already registered' });
  });

  it('creates no user when refused', async () => {
    const auth = await tenantAdmin('admin-b@questor.test');
    await request(app).post('/api/admin/users').set('Authorization', auth).send({ email: RESERVED.toUpperCase(), password: 'long-enough-password', name: 'Me', role: 'admin' });
    expect(await prisma.user.count({ where: { email: RESERVED } })).toBe(0);
  });

  it('is allowed when the request comes from a platform operator', async () => {
    const auth = await tenantAdmin('owner@questor.test');
    const res = await request(app).post('/api/admin/users').set('Authorization', auth).send({ email: RESERVED, password: 'long-enough-password', name: 'Co-owner', role: 'admin' });
    expect(res.status).toBe(201);
  });

  it('is refused through self-registration', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: RESERVED, password: 'long-enough-password', name: 'Me' });
    expect({ status: res.status, users: await prisma.user.count({ where: { email: RESERVED } }) }).toEqual({ status: 409, users: 0 });
  });

  it('is declined when a new-organisation signup is approved', async () => {
    const row = await signupRow(RESERVED, 'new-org');
    await decideSignupRequest({ id: row.id, decision: 'approve', actorId: 'approver' });
    const after = await prisma.signupRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect({ status: after.status, users: await prisma.user.count({ where: { email: RESERVED } }) }).toEqual({ status: 'DECLINED', users: 0 });
  });

  it('is declined when a join-organisation signup is approved', async () => {
    await prisma.tenant.create({ data: { name: 'Joinable', slug: 'joinable-org' } });
    const row = await signupRow(RESERVED, 'join', 'joinable-org');
    await decideSignupRequest({ id: row.id, decision: 'approve', actorId: 'approver' });
    expect(await prisma.user.count({ where: { email: RESERVED } })).toBe(0);
  });

  it('audits why the signup was declined', async () => {
    // A declined new-organisation request is audited against the approver's organisation.
    config.signupApproverEmail = 'approver@questor.test';
    await tenantAdmin('approver@questor.test');
    const row = await signupRow(RESERVED, 'new-org');
    await decideSignupRequest({ id: row.id, decision: 'approve', actorId: 'approver' });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: row.id } });
    expect(JSON.parse(event.afterJson).reason).toBe('email_reserved');
  });
});

describe('the start-up check', () => {
  it('logs an error for each operator address with no account', async () => {
    await tenantAdmin('owner@questor.test');
    const error = vi.spyOn(logger, 'error');
    await reportMissingOperatorAccounts();
    const logged = error.mock.calls.map((call) => JSON.stringify(call));
    expect({ reserved: logged.some((l) => l.includes(RESERVED)), owner: logged.some((l) => l.includes('"owner@questor.test"')) }).toEqual({ reserved: true, owner: false });
  });
});
