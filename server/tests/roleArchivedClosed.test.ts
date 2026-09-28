import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * An archived role is closed: nothing new attaches to it until it is restored.
 * Before this, archiving only hid the role from the list — candidates and
 * interviews could still be added, and approving a draft scorecard quietly
 * un-archived it outside the audited restore endpoint.
 */

const app = createApp();

let tenantId: string;
let admin: string;

async function archivedRole(scorecardStatus: 'draft' | 'approved') {
  const role = await prisma.role.create({ data: { tenantId, title: 'Closed Role', status: 'archived' } });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: scorecardStatus, profileJson: '{}' } });
  return { role, scorecard };
}

beforeEach(async () => {
  await wipe();
  tenantId = (await prisma.tenant.create({ data: { name: 'Closed Org' } })).id;
  const user = await prisma.user.create({ data: { tenantId, email: 'admin@closed.local', name: 'Admin', passwordHash: 'x', role: 'admin' } });
  admin = `Bearer ${signToken({ userId: user.id, tenantId, role: 'admin', email: user.email })}`;
});

describe('an archived role', () => {
  it('refuses a new candidate', async () => {
    const { role } = await archivedRole('approved');

    const res = await request(app).post('/api/candidates').set('Authorization', admin).send({ roleId: role.id, fullName: 'New Person', email: 'new@closed.test' });

    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'role_archived' });
  });

  it('refuses a new interview for a candidate already on it', async () => {
    const { role } = await archivedRole('approved');
    const candidate = await prisma.candidate.create({ data: { tenantId, roleId: role.id, fullName: 'Existing', email: 'existing@closed.test' } });

    const res = await request(app).post('/api/interviews').set('Authorization', admin).send({ candidateId: candidate.id, approve: true });

    expect(res.status).toBe(409);
  });

  it('refuses a bulk invitation for an interview already set up on it', async () => {
    const { role, scorecard } = await archivedRole('approved');
    const candidate = await prisma.candidate.create({ data: { tenantId, roleId: role.id, fullName: 'Bulk', email: 'bulk@closed.test' } });
    await prisma.interviewSession.create({ data: { tenantId, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id, state: 'PROVISIONED', provider: 'hosted' } });

    const res = await request(app).post('/api/interviews/bulk-invite').set('Authorization', admin).send([{ candidateId: candidate.id }]);

    expect(res.body.results[0]).toMatchObject({ success: false, error: expect.stringContaining('archived') });
  });

  it('mints no invitation link through bulk invite', async () => {
    const { role, scorecard } = await archivedRole('approved');
    const candidate = await prisma.candidate.create({ data: { tenantId, roleId: role.id, fullName: 'Bulk', email: 'bulk@closed.test' } });
    const session = await prisma.interviewSession.create({ data: { tenantId, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id, state: 'PROVISIONED', provider: 'hosted' } });

    await request(app).post('/api/interviews/bulk-invite').set('Authorization', admin).send([{ candidateId: candidate.id }]);

    expect(await prisma.invitation.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it('refuses to resend an invitation', async () => {
    const { role, scorecard } = await archivedRole('approved');
    const candidate = await prisma.candidate.create({ data: { tenantId, roleId: role.id, fullName: 'Resend', email: 'resend@closed.test' } });
    const session = await prisma.interviewSession.create({ data: { tenantId, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id, state: 'INVITED', provider: 'hosted' } });

    const res = await request(app).post(`/api/interviews/${session.id}/resend`).set('Authorization', admin);

    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'role_archived' });
  });

  it('refuses scorecard edits', async () => {
    const { role } = await archivedRole('draft');

    const res = await request(app).put(`/api/roles/${role.id}/scorecard`).set('Authorization', admin).send({ profile: {} });

    expect(res.status).toBe(409);
  });

  it('refuses scorecard approval, so approving cannot un-archive it', async () => {
    const { role, scorecard } = await archivedRole('draft');

    const res = await request(app).post(`/api/roles/${role.id}/approve`).set('Authorization', admin).send({ scorecardId: scorecard.id, version: 1 });

    expect({ status: res.status, stored: (await prisma.role.findUniqueOrThrow({ where: { id: role.id } })).status }).toEqual({ status: 409, stored: 'archived' });
  });
});
