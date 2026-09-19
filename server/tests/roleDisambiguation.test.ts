import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { getRoleMetrics } from '../src/services/roleMetrics.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';

/**
 * Three roles can share a title ("Senior Backend Engineer (Payments)"), so every
 * API that shows a role for display also carries what tells them apart.
 */

const app = createApp();
const TITLE = 'Senior Backend Engineer (Payments)';

interface Fixture { auth: string; roleId: string; tenantId: string; userId: string; createdAt: string }

async function setup(): Promise<Fixture> {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Disambiguation Org' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: 'admin@dis.local', name: 'Admin', passwordHash: 'x', role: 'admin' } });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: TITLE, level: 'Senior', regionCode: 'IN', experienceBand: 'senior', status: 'approved' } });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: 'approved', profileJson: '{}' } });
  const candidate = await prisma.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName: 'Ada', email: 'ada@dis.local' } });
  const session = await prisma.interviewSession.create({ data: { tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id, candidateId: candidate.id, state: 'REVIEW_READY', completedAt: new Date() } });
  await prisma.invitation.create({ data: { sessionId: session.id, ...invitationSecretColumns(mintInvitationToken()), sentAt: new Date() } });
  return {
    auth: `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email: user.email })}`,
    roleId: role.id, tenantId: tenant.id, userId: user.id, createdAt: role.createdAt.toISOString(),
  };
}

let f: Fixture;
beforeEach(async () => { f = await setup(); });

const expected = () => ({ level: 'Senior', regionCode: 'IN', experienceBand: 'senior', createdAt: f.createdAt });

describe('role disambiguation fields', () => {
  it('role metrics funnels carry level, region, band and creation time', async () => {
    const res = await request(app).get('/api/roles/metrics').set('Authorization', f.auth);
    expect(res.body.roles[0]).toMatchObject(expected());
  });

  it('role metrics top-by-applied items carry them', async () => {
    const res = await request(app).get('/api/roles/metrics').set('Authorization', f.auth);
    expect(res.body.topByApplied[0]).toMatchObject({ id: f.roleId, title: TITLE, count: 1, ...expected() });
  });

  it('role metrics top-by-interviewed items carry them', async () => {
    const res = await request(app).get('/api/roles/metrics').set('Authorization', f.auth);
    expect(res.body.topByInterviewed[0]).toMatchObject({ id: f.roleId, ...expected() });
  });

  it('the dashboard role charts carry them', async () => {
    const res = await request(app).get('/api/dashboard/metrics').set('Authorization', f.auth);
    expect(res.body.roles.topByApplied[0]).toMatchObject(expected());
  });

  it('dashboard recent interviews carry them on the role', async () => {
    const res = await request(app).get('/api/dashboard/metrics').set('Authorization', f.auth);
    expect(res.body.recentInterviews[0].role).toMatchObject({ id: f.roleId, title: TITLE, ...expected() });
  });

  it('GET /api/interviews carries them on the role', async () => {
    const res = await request(app).get('/api/interviews').set('Authorization', f.auth);
    expect(res.body.sessions[0].role).toMatchObject({ id: f.roleId, title: TITLE, ...expected() });
  });

  it('GET /api/candidates carries them beside roleTitle', async () => {
    const res = await request(app).get('/api/candidates').set('Authorization', f.auth);
    expect(res.body.candidates[0]).toMatchObject({ roleTitle: TITLE, roleLevel: 'Senior', roleRegionCode: 'IN', roleExperienceBand: 'senior', roleCreatedAt: f.createdAt });
  });
});

describe('L7: role metrics row ceiling', () => {
  it('reports truncation when the per-candidate session groups reach the ceiling', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { id: f.roleId } });
    const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: role.id } });
    const other = await prisma.candidate.create({ data: { tenantId: f.tenantId, roleId: role.id, fullName: 'Ben', email: 'ben@dis.local' } });
    const s = await prisma.interviewSession.create({ data: { tenantId: f.tenantId, roleId: role.id, scorecardId: scorecard.id, candidateId: other.id, state: 'REVIEW_READY' } });
    await prisma.invitation.create({ data: { sessionId: s.id, ...invitationSecretColumns(mintInvitationToken()) } });

    const metrics = await getRoleMetrics({ userId: f.userId, tenantId: f.tenantId, role: 'admin', email: 'admin@dis.local' }, { rowLimit: 2 });

    expect(metrics.truncated).toBe(true);
  });
});
