import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';

/**
 * An email address is one identity whatever case it is typed in.
 *
 * Signup lowercased; register and admin-create stored what was typed; login
 * looked up exactly what was typed. So "Priya@Acme.com" could be created by an
 * admin and then never sign in as "priya@acme.com" — or the reverse — and two
 * accounts could exist for one mailbox.
 */

const app = createApp();
// Not a credential: a fixture passphrase for users created inside this test.
const PASSPHRASE = 'fixture-passphrase-long-enough';

let adminBearer = '';
let tenantId = '';

beforeEach(async () => {
  await wipe();
  const demo = await createDemoData();
  const admin = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  tenantId = admin.tenantId;
  adminBearer = `Bearer ${signToken({ userId: admin.id, tenantId, role: admin.role, email: admin.email })}`;
});

const login = (email: string) => request(app).post('/api/auth/login').send({ email, password: PASSPHRASE });

describe('registering', () => {
  it('stores the address in lower case', async () => {
    await request(app).post('/api/auth/register').send({ email: ' Owner@Example.COM ', password: PASSPHRASE, name: 'Owner' });

    expect(await prisma.user.count({ where: { email: 'owner@example.com' } })).toBe(1);
  });

  it('refuses an address already registered in a different case', async () => {
    await request(app).post('/api/auth/register').send({ email: 'owner@example.com', password: PASSPHRASE, name: 'Owner' });

    const res = await request(app).post('/api/auth/register').send({ email: 'OWNER@example.com', password: PASSPHRASE, name: 'Owner' });

    expect(res.status).toBe(409);
  });
});

describe('an admin creating a user', () => {
  it('stores the address in lower case', async () => {
    await request(app).post('/api/admin/users').set('Authorization', adminBearer)
      .send({ email: 'New.Hire@Example.com', password: PASSPHRASE, name: 'New Hire', role: 'recruiter' });

    expect(await prisma.user.count({ where: { email: 'new.hire@example.com' } })).toBe(1);
  });

  it('refuses an address that exists in a different case', async () => {
    await prisma.user.create({ data: { tenantId, email: 'Legacy.User@Example.com', name: 'Legacy', passwordHash: hashPassword(PASSPHRASE), role: 'recruiter' } });

    const res = await request(app).post('/api/admin/users').set('Authorization', adminBearer)
      .send({ email: 'legacy.user@example.com', password: PASSPHRASE, name: 'Dup', role: 'recruiter' });

    expect(res.status).toBe(409);
  });
});

describe('signing in', () => {
  it('accepts the address typed in a different case from how it was stored', async () => {
    await prisma.user.create({ data: { tenantId, email: 'lower.case@example.com', name: 'Lower', passwordHash: hashPassword(PASSPHRASE), role: 'recruiter' } });

    expect((await login('Lower.Case@EXAMPLE.com')).status).toBe(200);
  });

  it('finds an account stored in mixed case before addresses were normalised', async () => {
    await prisma.user.create({ data: { tenantId, email: 'Legacy.User@Example.com', name: 'Legacy', passwordHash: hashPassword(PASSPHRASE), role: 'recruiter' } });

    expect((await login('legacy.user@example.com')).status).toBe(200);
  });

  it('still refuses a wrong password', async () => {
    await prisma.user.create({ data: { tenantId, email: 'lower.case@example.com', name: 'Lower', passwordHash: hashPassword(PASSPHRASE), role: 'recruiter' } });

    const res = await request(app).post('/api/auth/login').send({ email: 'LOWER.case@example.com', password: 'not-the-passphrase' });

    expect(res.status).toBe(401);
  });
});

describe('changing a user role', () => {
  it('leaves at least one admin when the last two are demoted at once', async () => {
    const [a, b] = await Promise.all(['admin-a@example.com', 'admin-b@example.com'].map((email) =>
      prisma.user.create({ data: { tenantId, email, name: email, passwordHash: hashPassword(PASSPHRASE), role: 'admin' } })));
    // The demo admin is demoted first so exactly two admins remain.
    const demoAdmin = await prisma.user.findFirstOrThrow({ where: { tenantId, email: 'demo@questor.local' } });
    const actor = `Bearer ${signToken({ userId: a.id, tenantId, role: 'admin', email: a.email })}`;
    await request(app).patch(`/api/admin/users/${demoAdmin.id}/role`).set('Authorization', actor).send({ role: 'recruiter' });

    await Promise.all([a, b].map((u) =>
      request(app).patch(`/api/admin/users/${u.id}/role`).set('Authorization', actor).send({ role: 'recruiter' })));

    expect(await prisma.user.count({ where: { tenantId, role: 'admin' } })).toBeGreaterThanOrEqual(1);
  });

  it('describes when the change takes effect accurately', async () => {
    const user = await prisma.user.create({ data: { tenantId, email: 'rec@example.com', name: 'Rec', passwordHash: hashPassword(PASSPHRASE), role: 'recruiter' } });

    const res = await request(app).patch(`/api/admin/users/${user.id}/role`).set('Authorization', adminBearer).send({ role: 'reviewer' });

    expect(res.body.note).toMatch(/next request/i);
  });
});
