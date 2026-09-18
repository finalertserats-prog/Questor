import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * M10: a role can be archived and restored. Restoring returns it to the state
 * its latest scorecard implies, so this endpoint can never stand in for
 * scorecard approval.
 */

const app = createApp();

async function makeUser(tenantId: string, email: string, role: string) {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, auth: `Bearer ${signToken({ userId: user.id, tenantId, role, email })}` };
}

async function makeRole(tenantId: string, scorecardStatus: 'draft' | 'approved', ownerId?: string) {
  const role = await prisma.role.create({ data: { tenantId, title: 'Payments Engineer', status: scorecardStatus } });
  await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: scorecardStatus, profileJson: '{}' } });
  if (ownerId) await prisma.roleAssignment.create({ data: { roleId: role.id, userId: ownerId, relation: 'owner' } });
  return role;
}

const setStatus = (auth: string, roleId: string, status: unknown) =>
  request(app).patch(`/api/roles/${roleId}/status`).set('Authorization', auth).send({ status });

let tenantId: string;
let admin: { id: string; auth: string };

beforeEach(async () => {
  await wipe();
  tenantId = (await prisma.tenant.create({ data: { name: 'Archive Org' } })).id;
  admin = await makeUser(tenantId, 'admin@archive.local', 'admin');
});

describe('PATCH /api/roles/:id/status', () => {
  it('archives a role', async () => {
    const role = await makeRole(tenantId, 'approved');

    const res = await setStatus(admin.auth, role.id, 'archived');

    expect({ status: res.status, stored: (await prisma.role.findUniqueOrThrow({ where: { id: role.id } })).status }).toEqual({ status: 200, stored: 'archived' });
  });

  it('answers with the new status', async () => {
    const role = await makeRole(tenantId, 'approved');

    const res = await setStatus(admin.auth, role.id, 'archived');

    expect(res.body.role).toMatchObject({ id: role.id, status: 'archived' });
  });

  it('restores an archived role with an approved scorecard to approved', async () => {
    const role = await makeRole(tenantId, 'approved');
    await setStatus(admin.auth, role.id, 'archived');

    const res = await setStatus(admin.auth, role.id, 'approved');

    expect(res.body.role.status).toBe('approved');
  });

  it('restores an archived role with a draft scorecard to draft, even when approved is asked for', async () => {
    const role = await makeRole(tenantId, 'draft');
    await setStatus(admin.auth, role.id, 'archived');

    const res = await setStatus(admin.auth, role.id, 'approved');

    expect(res.body.role.status).toBe('draft');
  });

  it('refuses to move a role that is not archived between draft and approved', async () => {
    const role = await makeRole(tenantId, 'draft');

    const res = await setStatus(admin.auth, role.id, 'approved');

    expect({ status: res.status, stored: (await prisma.role.findUniqueOrThrow({ where: { id: role.id } })).status }).toEqual({ status: 409, stored: 'draft' });
  });

  it('refuses an unknown status', async () => {
    const role = await makeRole(tenantId, 'draft');

    const res = await setStatus(admin.auth, role.id, 'deleted');

    expect(res.status).toBe(400);
  });

  it('records the archive in the audit log', async () => {
    const role = await makeRole(tenantId, 'approved');

    await setStatus(admin.auth, role.id, 'archived');

    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'role.archived', entityId: role.id } })).toBe(1);
  });

  it('refuses a recruiter, who cannot approve scorecards', async () => {
    const recruiter = await makeUser(tenantId, 'rec@archive.local', 'recruiter');
    const role = await makeRole(tenantId, 'approved', recruiter.id);

    const res = await setStatus(recruiter.auth, role.id, 'archived');

    expect(res.status).toBe(403);
  });

  it('answers 404 for a role in another organisation', async () => {
    const otherTenant = await prisma.tenant.create({ data: { name: 'Other Org' } });
    const role = await makeRole(otherTenant.id, 'approved');

    const res = await setStatus(admin.auth, role.id, 'archived');

    expect({ status: res.status, stored: (await prisma.role.findUniqueOrThrow({ where: { id: role.id } })).status }).toEqual({ status: 404, stored: 'approved' });
  });

  it('answers 404 to a manager for a role they are not assigned', async () => {
    const manager = await makeUser(tenantId, 'mgr@archive.local', 'manager');
    const role = await makeRole(tenantId, 'approved');

    const res = await setStatus(manager.auth, role.id, 'archived');

    expect(res.status).toBe(404);
  });

  it('lets a manager archive a role they own', async () => {
    const manager = await makeUser(tenantId, 'owner@archive.local', 'manager');
    const role = await makeRole(tenantId, 'approved', manager.id);

    const res = await setStatus(manager.auth, role.id, 'archived');

    expect(res.status).toBe(200);
  });
});
