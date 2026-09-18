import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { getRoleMetrics } from '../src/services/roleMetrics.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';

const app = createApp();
const HOUR = 3_600_000;
const now = new Date('2026-09-18T12:00:00.000Z');

async function makeUser(tenantId: string, email: string, role = 'admin') {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function makeRole(tenantId: string, title: string, status = 'approved') {
  const role = await prisma.role.create({ data: { tenantId, title, status } });
  const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
  return { role, scorecard };
}

async function makeCandidate(tenantId: string, roleId: string, name: string, assignTo?: string) {
  const candidate = await prisma.candidate.create({ data: { tenantId, roleId, fullName: name, email: `${name.replace(/\s+/g, '.')}@m.local` } });
  if (assignTo) await prisma.candidateAssignment.create({ data: { candidateId: candidate.id, userId: assignTo } });
  return candidate;
}

async function makeSession(o: {
  tenantId: string; roleId: string; scorecardId: string; candidateId: string; state?: string; hours?: number; createdAt?: Date;
}) {
  const completedAt = o.hours === undefined ? undefined : new Date(now.getTime());
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: o.tenantId, roleId: o.roleId, scorecardId: o.scorecardId, candidateId: o.candidateId,
      state: o.state ?? 'REVIEW_READY', completedAt, createdAt: o.createdAt ?? now,
    },
  });
  if (o.hours !== undefined) {
    await prisma.invitation.create({
      data: {
        sessionId: session.id,
        ...invitationSecretColumns(mintInvitationToken()),
        sentAt: new Date(now.getTime() - o.hours * HOUR),
      },
    });
  }
  return session;
}

async function makePipeline(tenantId: string, roleId: string, candidateId: string, decision: 'APPROVED' | 'REJECTED' | 'WITHDRAWN') {
  return prisma.candidatePipeline.create({
    data: { tenantId, roleId, candidateId, stagesJson: '', currentStageKey: 'silver', status: 'DECIDED', decision, decidedAt: now },
  });
}

beforeEach(async () => {
  await wipe();
});

describe('getRoleMetrics', () => {
  it('counts distinct candidates for retakes and excludes withdrawn decisions from advance rate', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Roles Org' } });
    const admin = await makeUser(tenant.id, 'admin@roles.local');
    const { role, scorecard } = await makeRole(tenant.id, 'Engineer');
    const candidate = await makeCandidate(tenant.id, role.id, 'Ada');
    await makeSession({ tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id, candidateId: candidate.id, state: 'REVIEW_READY' });
    await makeSession({ tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id, candidateId: candidate.id, state: 'CLOSED' });

    const decisions: Array<'APPROVED' | 'REJECTED' | 'WITHDRAWN'> = ['APPROVED', 'APPROVED', 'APPROVED', 'REJECTED', 'REJECTED', 'WITHDRAWN'];
    for (let i = 0; i < decisions.length; i += 1) {
      const c = await makeCandidate(tenant.id, role.id, `Decision ${i}`);
      await makePipeline(tenant.id, role.id, c.id, decisions[i]);
    }

    const metrics = await getRoleMetrics({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: 'admin@roles.local' }, { now });
    expect(metrics.roles[0]).toMatchObject({
      applied: 7,
      interviewInvited: 1,
      interviewed: 1,
      awaitingReview: 1,
      decisions: { APPROVED: 3, REJECTED: 2, WITHDRAWN: 1 },
      advanceRate: 0.6,
    });
  });

  it('keeps advance rate and median null below five samples, then computes odd and even medians', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Median Org' } });
    const admin = await makeUser(tenant.id, 'admin@median.local');
    const odd = await makeRole(tenant.id, 'Odd Median');
    const even = await makeRole(tenant.id, 'Even Median');
    const low = await makeRole(tenant.id, 'Low Sample');

    for (const hours of [1, 2, 3, 4, 100]) {
      const c = await makeCandidate(tenant.id, odd.role.id, `Odd ${hours}`);
      await makeSession({ tenantId: tenant.id, roleId: odd.role.id, scorecardId: odd.scorecard.id, candidateId: c.id, state: 'CLOSED', hours });
    }
    for (const hours of [1, 2, 4, 8, 10, 12]) {
      const c = await makeCandidate(tenant.id, even.role.id, `Even ${hours}`);
      await makeSession({ tenantId: tenant.id, roleId: even.role.id, scorecardId: even.scorecard.id, candidateId: c.id, state: 'CLOSED', hours });
    }
    for (const hours of [1, 2, 3, 4]) {
      const c = await makeCandidate(tenant.id, low.role.id, `Low ${hours}`);
      await makeSession({ tenantId: tenant.id, roleId: low.role.id, scorecardId: low.scorecard.id, candidateId: c.id, state: 'CLOSED', hours });
      await makePipeline(tenant.id, low.role.id, c.id, 'APPROVED');
    }

    const byTitle = new Map((await getRoleMetrics({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: 'admin@median.local' }, { now })).roles.map((r) => [r.title, r]));
    expect(byTitle.get('Odd Median')?.medianInviteToCompleteHours).toBe(3);
    expect(byTitle.get('Even Median')?.medianInviteToCompleteHours).toBe(6);
    expect(byTitle.get('Low Sample')?.medianInviteToCompleteHours).toBe(null);
    expect(byTitle.get('Low Sample')?.advanceRate).toBe(null);
  });

  it('calculates role KPIs, top tens, title tie-breaks, scoping and tenant isolation', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Scope Org' } });
    const otherTenant = await prisma.tenant.create({ data: { name: 'Other Org' } });
    const recruiter = await makeUser(tenant.id, 'rec@scope.local', 'recruiter');
    const admin = await makeUser(tenant.id, 'admin@scope.local');
    const roleA = await makeRole(tenant.id, 'A Role');
    const roleB = await makeRole(tenant.id, 'B Role');
    const archived = await makeRole(tenant.id, 'Archived', 'archived');
    await prisma.roleAssignment.create({ data: { roleId: roleA.role.id, userId: recruiter.id } });

    const visible = await makeCandidate(tenant.id, roleA.role.id, 'Visible');
    await makeSession({ tenantId: tenant.id, roleId: roleA.role.id, scorecardId: roleA.scorecard.id, candidateId: visible.id, state: 'REVIEW_READY' });
    await makeCandidate(tenant.id, roleA.role.id, 'Visible via role');
    await makeCandidate(tenant.id, roleB.role.id, 'Hidden');
    await makeCandidate(tenant.id, archived.role.id, 'Archived candidate');
    const theirRole = await makeRole(otherTenant.id, 'Other Tenant');
    await makeCandidate(otherTenant.id, theirRole.role.id, 'Other Tenant Candidate');

    for (let i = 0; i < 12; i += 1) {
      const extra = await makeRole(tenant.id, i < 2 ? `Tie ${String.fromCharCode(66 - i)}` : `Top ${i}`);
      const candidate = await makeCandidate(tenant.id, extra.role.id, `Top Cand ${i}`);
      await makeSession({ tenantId: tenant.id, roleId: extra.role.id, scorecardId: extra.scorecard.id, candidateId: candidate.id, state: 'CLOSED' });
    }

    const recMetrics = await getRoleMetrics({ userId: recruiter.id, tenantId: tenant.id, role: 'recruiter', email: 'rec@scope.local' }, { now });
    expect(recMetrics.roles.map((r) => r.title)).toEqual(['A Role']);
    expect(recMetrics.roles[0].applied).toBe(2);

    const metrics = await getRoleMetrics({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: 'admin@scope.local' }, { now });
    expect(metrics.kpis).toEqual({ activeRoles: 14, rolesWithoutCandidates: 0, rolesWithReviewBacklog: 1 });
    expect(metrics.topByApplied).toHaveLength(10);
    expect(metrics.topByInterviewed).toHaveLength(10);
    expect(metrics.topByApplied.filter((r) => r.title === 'Other Tenant')).toEqual([]);
    expect(metrics.topByApplied.findIndex((r) => r.title === 'Tie A')).toBeLessThan(metrics.topByApplied.findIndex((r) => r.title === 'Tie B'));
  });
});

describe('GET /api/roles/metrics', () => {
  it('gates candidate metrics, rejects unknown query keys, is not swallowed by /:id, and dashboard includes roles', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'HTTP Org' } });
    const auditor = await makeUser(tenant.id, 'auditor@http.local', 'auditor');
    const admin = await makeUser(tenant.id, 'admin@http.local');

    expect((await request(app).get('/api/roles/metrics').set('Authorization', `Bearer ${auditor.token}`)).status).toBe(403);
    expect((await request(app).get('/api/roles/metrics?tenantId=x').set('Authorization', `Bearer ${admin.token}`)).status).toBe(400);
    const metrics = await request(app).get('/api/roles/metrics').set('Authorization', `Bearer ${admin.token}`);
    expect(metrics.status).toBe(200);
    expect(metrics.body).toHaveProperty('roles');
    const dashboard = await request(app).get('/api/dashboard/metrics').set('Authorization', `Bearer ${admin.token}`);
    expect(dashboard.body.roles).toHaveProperty('topByApplied');
  });
});
