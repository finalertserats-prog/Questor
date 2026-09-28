import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';

const app = createApp();

async function makeUser(tenantId: string, email: string, role = 'recruiter') {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function makeRoleSet(tenantId: string, title = 'Support Engineer') {
  const role = await prisma.role.create({ data: { tenantId, title, status: 'approved' } });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, status: 'approved', profileJson: JSON.stringify({ competencies: [] }) },
  });
  return { role, scorecard };
}

async function makeCandidateSession(o: {
  tenantId: string;
  roleId: string;
  scorecardId: string;
  fullName: string;
  email: string;
  state?: string;
  assignToUserId?: string;
}) {
  const candidate = await prisma.candidate.create({
    data: { tenantId: o.tenantId, roleId: o.roleId, fullName: o.fullName, email: o.email },
  });
  if (o.assignToUserId) {
    await prisma.candidateAssignment.create({
      data: { candidateId: candidate.id, userId: o.assignToUserId, relation: 'owner' },
    });
  }
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: o.tenantId,
      candidateId: candidate.id,
      roleId: o.roleId,
      scorecardId: o.scorecardId,
      state: o.state ?? 'PROVISIONED',
    },
  });
  return { candidate, session };
}

beforeEach(async () => {
  await wipe();
});

describe('bulk candidate invite', () => {
  it('returns per-row results and keeps inviting accessible candidates when another row is out of scope', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Bulk Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@bulk.local');
    const { role, scorecard } = await makeRoleSet(tenant.id);
    const good = await makeCandidateSession({
      tenantId: tenant.id,
      roleId: role.id,
      scorecardId: scorecard.id,
      fullName: 'Accessible Candidate',
      email: 'good@bulk.local',
      assignToUserId: recruiter.id,
    });
    const hidden = await makeCandidateSession({
      tenantId: tenant.id,
      roleId: role.id,
      scorecardId: scorecard.id,
      fullName: 'Hidden Candidate',
      email: 'hidden@bulk.local',
    });

    const res = await request(app)
      .post('/api/interviews/bulk-invite')
      .set('Authorization', `Bearer ${recruiter.token}`)
      .send([{ candidateId: good.candidate.id }, { candidateId: hidden.candidate.id }]);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toMatchObject({ index: 0, candidateId: good.candidate.id, sessionId: good.session.id, success: true });
    expect(res.body.results[0].invitation.portalUrl).toContain('/portal/');
    expect(res.body.results[1]).toMatchObject({ index: 1, candidateId: hidden.candidate.id, success: false, error: 'Candidate not found' });

    expect(await prisma.invitation.count({ where: { sessionId: good.session.id } })).toBe(1);
    expect(await prisma.invitation.count({ where: { sessionId: hidden.session.id } })).toBe(0);
    expect((await prisma.interviewSession.findUniqueOrThrow({ where: { id: good.session.id } })).state).toBe('INVITED');
    expect((await prisma.interviewSession.findUniqueOrThrow({ where: { id: hidden.session.id } })).state).toBe('PROVISIONED');
  });
});

describe('pipeline summary', () => {
  it('aggregates scoped interview counts by state and narrows by roleId', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Pipeline Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@pipeline.local');
    const roleA = await makeRoleSet(tenant.id, 'Backend Engineer');
    const roleB = await makeRoleSet(tenant.id, 'Data Engineer');

    await makeCandidateSession({ tenantId: tenant.id, roleId: roleA.role.id, scorecardId: roleA.scorecard.id, fullName: 'One', email: 'one@pipeline.local', state: 'PROVISIONED', assignToUserId: recruiter.id });
    await makeCandidateSession({ tenantId: tenant.id, roleId: roleA.role.id, scorecardId: roleA.scorecard.id, fullName: 'Two', email: 'two@pipeline.local', state: 'INVITED', assignToUserId: recruiter.id });
    await makeCandidateSession({ tenantId: tenant.id, roleId: roleB.role.id, scorecardId: roleB.scorecard.id, fullName: 'Three', email: 'three@pipeline.local', state: 'REVIEW_READY', assignToUserId: recruiter.id });
    await makeCandidateSession({ tenantId: tenant.id, roleId: roleB.role.id, scorecardId: roleB.scorecard.id, fullName: 'Hidden', email: 'hidden@pipeline.local', state: 'CANCELLED' });

    const all = await request(app)
      .get('/api/interviews/pipeline-summary')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(all.status).toBe(200);
    expect(all.body).toEqual({
      stateCounts: { PROVISIONED: 1, INVITED: 1, REVIEW_READY: 1 },
      total: 3,
    });

    const filtered = await request(app)
      .get(`/api/interviews/pipeline-summary?roleId=${roleA.role.id}`)
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual({
      stateCounts: { PROVISIONED: 1, INVITED: 1 },
      total: 2,
    });
  });
});
