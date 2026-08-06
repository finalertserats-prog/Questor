import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';

// These tests are written against the HTTP surface rather than against
// requireCapability directly. A unit test of the middleware would still pass if
// someone forgot to mount it on a route, which is the exact bug being fixed
// here — the capability check was correct all along, it simply was not applied.

const app = createApp();

const ADMIN_PASSWORD = 'admin-correct-horse-battery';
const MEMBER_PASSWORD = 'member-correct-horse-battery';

let adminToken = '';
let memberToken = '';

const asAdmin = (path: string) => request(app).get(path).set('Authorization', `Bearer ${adminToken}`);
const asMember = (path: string) => request(app).get(path).set('Authorization', `Bearer ${memberToken}`);

beforeAll(async () => {
  await wipe();

  // The first user of a new tenant is its admin — that is the only way an admin
  // can come into existence, by design in /api/auth/register.
  const admin = await request(app).post('/api/auth/register').send({
    email: 'admin@access.local', password: ADMIN_PASSWORD, name: 'Access Admin', tenantName: 'Access Org',
  });
  expect(admin.status).toBe(201);
  adminToken = admin.body.token;

  // The non-admin is created through the endpoint under test, because that is
  // now the only path to a second user in a tenant.
  const member = await request(app).post('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ email: 'member@access.local', password: MEMBER_PASSWORD, name: 'Access Member', role: 'recruiter' });
  expect(member.status).toBe(201);

  const login = await request(app).post('/api/auth/login')
    .send({ email: 'member@access.local', password: MEMBER_PASSWORD });
  expect(login.status).toBe(200);
  memberToken = login.body.token;
});

describe('admin endpoints are gated on capability, not authentication alone', () => {
  // One case per leak found in review. Split rather than looped so a failure
  // names the endpoint that regressed.
  it('denies a recruiter the audit log', async () => {
    expect((await asMember('/api/admin/audit')).status).toBe(403);
  });

  it('denies a recruiter the webhook list', async () => {
    expect((await asMember('/api/admin/webhooks')).status).toBe(403);
  });

  it('denies a recruiter the tenant policy', async () => {
    expect((await asMember('/api/admin/policy')).status).toBe(403);
  });

  it('allows an admin the audit log', async () => {
    const res = await asAdmin('/api/admin/audit');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  it('allows an admin the webhook list', async () => {
    const res = await asAdmin('/api/admin/webhooks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.webhooks)).toBe(true);
  });

  it('allows an admin the tenant policy', async () => {
    expect((await asAdmin('/api/admin/policy')).status).toBe(200);
  });

  // Guards the choice of `assessment:read` over `audit:read` for analytics. A
  // recruiter holds assessment:read, so the gate must let them through — if
  // someone later "tightens" this to admin:manage, the recruiter dashboard goes
  // blank and this test says why it was allowed.
  it('allows a recruiter analytics, which is gated on assessment:read', async () => {
    expect((await asMember('/api/admin/analytics')).status).toBe(200);
  });

  it('rejects an unauthenticated caller before any capability check', async () => {
    expect((await request(app).get('/api/admin/audit')).status).toBe(401);
  });
});

describe('admin user management', () => {
  it('creates a user with exactly the requested role', async () => {
    const res = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'reviewer@access.local', password: 'reviewer-correct-horse', name: 'Rev', role: 'reviewer' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('reviewer');
  });

  // The role must come from the body and nothing else — no silent upgrade to the
  // creator's own role, which would make every created user an admin.
  it('does not inherit the creating admin\'s role', async () => {
    const res = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'auditor@access.local', password: 'auditor-correct-horse', name: 'Aud', role: 'auditor' });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('auditor');
    expect(res.body.user.role).not.toBe('admin');
  });

  it('never returns the password hash', async () => {
    const res = await asAdmin('/api/admin/users');
    expect(res.status).toBe(200);
    for (const user of res.body.users) expect(user.passwordHash).toBeUndefined();
  });

  // An unrecognised role resolves to NO capabilities, so accepting one would
  // create an account that is silently powerless rather than loudly rejected.
  it('rejects a role outside the fixed ROLES set', async () => {
    const res = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'bogus@access.local', password: 'bogus-correct-horse-x', name: 'Bogus', role: 'superuser' });

    expect(res.status).toBe(400);
  });

  it('rejects a near-miss typo of a real role', async () => {
    const res = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'typo@access.local', password: 'typo-correct-horse-xy', name: 'Typo', role: 'recruter' });

    expect(res.status).toBe(400);
  });

  it('denies a non-admin the ability to create users', async () => {
    const res = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ email: 'escalate@access.local', password: 'escalate-correct-horse', name: 'Esc', role: 'admin' });

    expect(res.status).toBe(403);
  });

  it('denies a non-admin the user list', async () => {
    expect((await asMember('/api/admin/users')).status).toBe(403);
  });

  // Demoting the only admin would leave nobody able to grant admin:manage back,
  // and the tenant would need database surgery to recover.
  it('refuses to demote the last admin', async () => {
    const users = await asAdmin('/api/admin/users');
    const admin = users.body.users.find((u: { role: string }) => u.role === 'admin');

    const res = await request(app).patch(`/api/admin/users/${admin.id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'recruiter' });

    expect(res.status).toBe(409);
  });

  it('changes a role once another admin exists', async () => {
    const second = await request(app).post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'admin2@access.local', password: 'admin2-correct-horse', name: 'Admin Two', role: 'admin' });
    expect(second.status).toBe(201);

    const res = await request(app).patch(`/api/admin/users/${second.body.user.id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'manager' });

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('manager');
  });

  // 404 not 403: distinguishing "exists but not yours" from "does not exist"
  // confirms an id belonging to another tenant.
  it('reports an unknown user as not found rather than forbidden', async () => {
    const res = await request(app).patch('/api/admin/users/does-not-exist/role')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'reviewer' });

    expect(res.status).toBe(404);
  });
});
