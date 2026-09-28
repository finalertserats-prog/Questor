import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';

// GET /api/admin/audit — filtering and pagination for the standalone audit page.
// Capability gating (recruiter 403, admin 200) is covered in accessAdmin.test.ts.

const app = createApp();

interface Fx {
  adminToken: string;
  auditorToken: string;
  adminId: string;
  otherUserId: string;
}
let fx: Fx;

const DAY = 86_400_000;

beforeAll(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Audit Page Org' } });
  const other = await prisma.tenant.create({ data: { name: 'Other Audit Org' } });

  const admin = await prisma.user.create({ data: { tenantId: tenant.id, email: 'admin@audit.local', name: 'Asha Admin', passwordHash: 'x', role: 'admin' } });
  const auditor = await prisma.user.create({ data: { tenantId: tenant.id, email: 'aud@audit.local', name: 'Omar Auditor', passwordHash: 'x', role: 'auditor' } });
  const recruiter = await prisma.user.create({ data: { tenantId: tenant.id, email: 'rec@audit.local', name: 'Rita Recruiter', passwordHash: 'x', role: 'recruiter' } });

  const now = Date.now();
  const events = [
    { actorId: admin.id, action: 'user.created', createdAt: new Date(now - 10 * DAY) },
    { actorId: admin.id, action: 'role.assigned', createdAt: new Date(now - 5 * DAY) },
    { actorId: recruiter.id, action: 'candidate.created', createdAt: new Date(now - 3 * DAY) },
    { actorId: recruiter.id, action: 'candidate.created', createdAt: new Date(now - 2 * DAY) },
    { actorId: recruiter.id, action: 'interview.approved', createdAt: new Date(now - 1 * DAY) },
    { actorId: 'system', actorType: 'system', action: 'retention.purged', createdAt: new Date(now - 1000) },
  ];
  await prisma.auditEvent.createMany({
    data: events.map((e) => ({ tenantId: tenant.id, entityType: 'X', actorType: 'user', ...e })),
  });
  await prisma.auditEvent.create({ data: { tenantId: other.id, actorId: 'foreign', action: 'candidate.created', entityType: 'X' } });

  fx = {
    adminToken: signToken({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: admin.email }),
    auditorToken: signToken({ userId: auditor.id, tenantId: tenant.id, role: 'auditor', email: auditor.email }),
    adminId: admin.id,
    otherUserId: recruiter.id,
  };
});

const audit = (token: string, query = '') =>
  request(app).get(`/api/admin/audit${query}`).set('Authorization', `Bearer ${token}`);

describe('GET /api/admin/audit', () => {
  it('lets an auditor read the audit log', async () => {
    const res = await audit(fx.auditorToken);
    expect(res.status).toBe(200);
  });

  it("returns only this tenant's events, newest first", async () => {
    const res = await audit(fx.adminToken);
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual([
      'retention.purged', 'interview.approved', 'candidate.created', 'candidate.created', 'role.assigned', 'user.created',
    ]);
  });

  it('filters by action', async () => {
    const res = await audit(fx.adminToken, '?action=candidate.created');
    expect(res.body.meta.total).toBe(2);
  });

  it('filters by actor', async () => {
    const res = await audit(fx.adminToken, `?actorId=${fx.adminId}`);
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual(['role.assigned', 'user.created']);
  });

  it('filters by date range', async () => {
    const from = new Date(Date.now() - 4 * DAY).toISOString();
    const to = new Date(Date.now() - 1.5 * DAY).toISOString();
    const res = await audit(fx.adminToken, `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.body.meta.total).toBe(2);
  });

  it('paginates with total, page and limit in meta', async () => {
    const res = await audit(fx.adminToken, '?page=2&limit=4');
    expect({ meta: res.body.meta, count: res.body.events.length }).toEqual({ meta: { total: 6, page: 2, limit: 4 }, count: 2 });
  });

  it("resolves a user actor's name", async () => {
    const res = await audit(fx.adminToken, `?actorId=${fx.otherUserId}&limit=1`);
    expect(res.body.events[0].actorName).toBe('Rita Recruiter');
  });

  it('lists the distinct actions and actors available to filter by', async () => {
    const res = await audit(fx.adminToken);
    expect({
      actions: res.body.filters.actions,
      actors: res.body.filters.actors.map((a: { name: string }) => a.name).sort(),
    }).toEqual({
      actions: ['candidate.created', 'interview.approved', 'retention.purged', 'role.assigned', 'user.created'],
      actors: ['Asha Admin', 'Rita Recruiter', 'system'],
    });
  });

  it('rejects an out-of-range limit', async () => {
    const res = await audit(fx.adminToken, '?limit=5000');
    expect(res.status).toBe(400);
  });

  it('rejects a malformed date', async () => {
    const res = await audit(fx.adminToken, '?from=yesterday');
    expect(res.status).toBe(400);
  });
});
