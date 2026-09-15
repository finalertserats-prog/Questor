import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';

// GET /api/dashboard/metrics — the HR dashboard's KPIs and chart series.
//
// The endpoint aggregates across candidates, so the risk is not a wrong number
// but a RIGHT number about the wrong people: a recruiter learning how many
// candidates another recruiter is interviewing. Every count must go through
// the same candidate/role scope the list routes use.

const app = createApp();
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ahead = (days: number) => new Date(Date.now() + days * DAY);

async function makeTenant(name: string) {
  return prisma.tenant.create({ data: { name } });
}

async function makeUser(tenantId: string, email: string, role = 'recruiter') {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function makeRole(tenantId: string, title: string, status = 'approved') {
  const role = await prisma.role.create({ data: { tenantId, title, status } });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, status: 'approved', profileJson: '{}' },
  });
  return { role, scorecard };
}

async function makeCandidate(tenantId: string, roleId: string, fullName: string, assignTo?: string) {
  const candidate = await prisma.candidate.create({
    data: { tenantId, roleId, fullName, email: `${fullName.replace(/\s+/g, '.').toLowerCase()}@m.local` },
  });
  if (assignTo) {
    await prisma.candidateAssignment.create({ data: { candidateId: candidate.id, userId: assignTo, relation: 'owner' } });
  }
  return candidate;
}

async function makeSession(o: {
  tenantId: string; candidateId: string; roleId: string; scorecardId: string;
  state: string; createdAt?: Date; scheduledAt?: Date; completedAt?: Date; invitedAt?: Date;
}) {
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId, scorecardId: o.scorecardId,
      state: o.state, createdAt: o.createdAt, scheduledAt: o.scheduledAt ?? null, completedAt: o.completedAt ?? null,
    },
  });
  if (o.invitedAt) {
    await prisma.invitation.create({
      data: { sessionId: session.id, token: `tok${session.id}`, status: 'sent', sentAt: o.invitedAt },
    });
  }
  return session;
}

async function makePipeline(o: {
  tenantId: string; candidateId: string; roleId: string; stage: string;
  status?: string; decision?: string;
}) {
  return prisma.candidatePipeline.create({
    data: {
      tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId, stagesJson: '',
      currentStageKey: o.stage, status: o.status ?? 'ACTIVE', decision: o.decision ?? null,
      decidedAt: o.decision ? ago(1) : null,
    },
  });
}

async function makeRound(o: {
  tenantId: string; pipelineId: string; scheduledAt: Date; status?: string; completedAt?: Date;
  conductedBy?: string; sessionId?: string;
}) {
  return prisma.interviewRound.create({
    data: {
      tenantId: o.tenantId, pipelineId: o.pipelineId, stageKey: 'gold',
      conductedBy: o.conductedBy ?? 'HUMAN', sessionId: o.sessionId ?? null,
      scheduledAt: o.scheduledAt, status: o.status ?? 'SCHEDULED', completedAt: o.completedAt ?? null,
    },
  });
}

const getMetrics = (token: string, query = '') =>
  request(app).get(`/api/dashboard/metrics${query}`).set('Authorization', `Bearer ${token}`);

beforeEach(async () => {
  await wipe();
});

describe('GET /api/dashboard/metrics — access', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/dashboard/metrics');
    expect(res.status).toBe(401);
  });

  it('denies an auditor, who may not read candidate detail', async () => {
    const tenant = await makeTenant('Audit Org');
    const auditor = await makeUser(tenant.id, 'auditor@m.local', 'auditor');
    const res = await getMetrics(auditor.token);
    expect(res.status).toBe(403);
  });

  it('rejects an out-of-range weeks parameter', async () => {
    const tenant = await makeTenant('Bad Query Org');
    const admin = await makeUser(tenant.id, 'admin@bad.local', 'admin');
    const res = await getMetrics(admin.token, '?weeks=500');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown query parameter', async () => {
    const tenant = await makeTenant('Unknown Query Org');
    const admin = await makeUser(tenant.id, 'admin@unknown.local', 'admin');
    const res = await getMetrics(admin.token, '?tenantId=someone-else');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/dashboard/metrics — counts', () => {
  async function seedTenant() {
    const tenant = await makeTenant('Counts Org');
    const admin = await makeUser(tenant.id, 'admin@counts.local', 'admin');
    const { role, scorecard } = await makeRole(tenant.id, 'Data Engineer');
    await makeRole(tenant.id, 'Draft Role', 'draft');
    await makeRole(tenant.id, 'Old Role', 'archived');
    const base = { tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id };

    const c1 = await makeCandidate(tenant.id, role.id, 'Ana One');
    const c2 = await makeCandidate(tenant.id, role.id, 'Ben Two');
    const c3 = await makeCandidate(tenant.id, role.id, 'Cy Three');
    const c4 = await makeCandidate(tenant.id, role.id, 'Di Four');
    const c5 = await makeCandidate(tenant.id, role.id, 'Ed Five');

    // Completed 3 days ago, invited 10h before completion.
    await makeSession({ ...base, candidateId: c1.id, state: 'REVIEW_READY', createdAt: ago(5), completedAt: ago(3), invitedAt: new Date(ago(3).getTime() - 10 * 3600_000) });
    // Completed 2 days ago, invited 20h before completion.
    await makeSession({ ...base, candidateId: c2.id, state: 'HUMAN_REVIEWED', createdAt: ago(4), completedAt: ago(2), invitedAt: new Date(ago(2).getTime() - 20 * 3600_000) });
    // Completed 40 days ago: outside the 30-day KPI.
    await makeSession({ ...base, candidateId: c3.id, state: 'CLOSED', createdAt: ago(45), completedAt: ago(40) });
    // Withdrew: has completedAt but is not a completed interview.
    await makeSession({ ...base, candidateId: c4.id, state: 'CANDIDATE_WITHDREW', createdAt: ago(6), completedAt: ago(1) });
    // Invited and scheduled two days from now.
    await makeSession({ ...base, candidateId: c5.id, state: 'INVITED', createdAt: ago(1), scheduledAt: ahead(2) });

    const p1 = await makePipeline({ tenantId: tenant.id, candidateId: c1.id, roleId: role.id, stage: 'silver' });
    await makePipeline({ tenantId: tenant.id, candidateId: c2.id, roleId: role.id, stage: 'silver' });
    const p3 = await makePipeline({ tenantId: tenant.id, candidateId: c3.id, roleId: role.id, stage: 'gold' });
    await makePipeline({ tenantId: tenant.id, candidateId: c4.id, roleId: role.id, stage: 'bronze', status: 'DECIDED', decision: 'REJECTED' });
    await makePipeline({ tenantId: tenant.id, candidateId: c5.id, roleId: role.id, stage: 'platinum', status: 'DECIDED', decision: 'APPROVED' });

    await makeRound({ tenantId: tenant.id, pipelineId: p3.id, scheduledAt: ahead(3) });
    await makeRound({ tenantId: tenant.id, pipelineId: p3.id, scheduledAt: ahead(10) });
    await makeRound({ tenantId: tenant.id, pipelineId: p1.id, scheduledAt: ago(2), status: 'COMPLETED', completedAt: ago(1) });
    await makeRound({ tenantId: tenant.id, pipelineId: p1.id, scheduledAt: ahead(1), status: 'CANCELLED' });

    return { tenant, admin };
  }

  it('counts open (non-archived) roles', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.kpis.openRoles).toBe(2);
  });

  it('counts candidates and active pipelines', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect({ candidates: res.body.kpis.candidates, activePipelines: res.body.kpis.activePipelines })
      .toEqual({ candidates: 5, activePipelines: 3 });
  });

  it('counts AI interviews and human rounds scheduled in the next 7 days', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.kpis.scheduledNext7Days).toBe(2);
  });

  it('counts completed interviews and rounds in the last 30 days, excluding withdrawals', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.kpis.completedLast30Days).toBe(3);
  });

  it('counts interviews awaiting human review', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.kpis.awaitingReview).toBe(1);
  });

  it('averages the hours from invitation to completed interview', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.kpis.avgInviteToCompleteHours).toBe(15);
  });

  it('counts pipeline decisions by outcome', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.kpis.decisions).toEqual({ APPROVED: 1, REJECTED: 1, WITHDRAWN: 0 });
  });

  it('reports active pipelines per medallion stage in stage order', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.pipelineStages).toEqual([
      { key: 'participation', label: 'Participation', count: 0 },
      { key: 'bronze', label: 'Bronze', count: 0 },
      { key: 'silver', label: 'Silver', count: 2 },
      { key: 'gold', label: 'Gold', count: 1 },
      { key: 'platinum', label: 'Platinum', count: 0 },
      { key: 'diamond', label: 'Diamond', count: 0 },
    ]);
  });

  it('reports session counts by state', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    expect(res.body.stateCounts).toEqual({ REVIEW_READY: 1, HUMAN_REVIEWED: 1, CLOSED: 1, CANDIDATE_WITHDREW: 1, INVITED: 1 });
  });

  it('returns 12 weekly buckets by default, oldest first', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    const weeks = res.body.interviewsPerWeek as Array<{ weekStart: string }>;
    expect(weeks.length === 12 && new Date(weeks[0].weekStart) < new Date(weeks[11].weekStart)).toBe(true);
  });

  it('puts this week\'s completions and set-ups in the newest bucket', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token);
    const newest = res.body.interviewsPerWeek.at(-1);
    // Completed within 7 days: two AI interviews + one human round.
    // Set up within 7 days: four sessions (created 5, 4, 6 and 1 days ago) + all four rounds.
    expect({ completed: newest.completed, created: newest.created }).toEqual({ completed: 3, created: 8 });
  });

  it('honours the weeks parameter', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token, '?weeks=8');
    expect(res.body.interviewsPerWeek).toHaveLength(8);
  });

  it('lists recent interviews newest first, limited by the recent parameter', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token, '?recent=2');
    expect(res.body.recentInterviews.map((r: { candidate: { name: string } }) => r.candidate.name)).toEqual(['Ed Five', 'Ben Two']);
  });

  it('shapes a recent interview row without transcript or token data', async () => {
    const { admin } = await seedTenant();
    const res = await getMetrics(admin.token, '?recent=1');
    expect(Object.keys(res.body.recentInterviews[0]).sort()).toEqual(
      ['candidate', 'completedAt', 'createdAt', 'id', 'role', 'scheduledAt', 'state'],
    );
  });
});

describe('GET /api/dashboard/metrics — tenant isolation', () => {
  it("never counts another tenant's data", async () => {
    const mine = await makeTenant('Mine');
    const theirs = await makeTenant('Theirs');
    const admin = await makeUser(mine.id, 'admin@mine.local', 'admin');

    const { role, scorecard } = await makeRole(theirs.id, 'Their Role');
    const cand = await makeCandidate(theirs.id, role.id, 'Their Candidate');
    await makeSession({ tenantId: theirs.id, candidateId: cand.id, roleId: role.id, scorecardId: scorecard.id, state: 'REVIEW_READY', completedAt: ago(1) });
    const pipe = await makePipeline({ tenantId: theirs.id, candidateId: cand.id, roleId: role.id, stage: 'silver' });
    await makeRound({ tenantId: theirs.id, pipelineId: pipe.id, scheduledAt: ahead(1) });

    const res = await getMetrics(admin.token);
    expect({
      kpis: res.body.kpis,
      recent: res.body.recentInterviews,
      states: res.body.stateCounts,
    }).toEqual({
      kpis: {
        openRoles: 0, candidates: 0, activePipelines: 0, scheduledNext7Days: 0, completedLast30Days: 0,
        awaitingReview: 0, avgInviteToCompleteHours: null, decisions: { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 },
      },
      recent: [],
      states: {},
    });
  });
});

describe('GET /api/dashboard/metrics — assignment scoping', () => {
  async function seedScoped() {
    const tenant = await makeTenant('Scoped Org');
    const recruiter = await makeUser(tenant.id, 'rec@scoped.local', 'recruiter');
    const roleOwner = await makeUser(tenant.id, 'owner@scoped.local', 'recruiter');
    const admin = await makeUser(tenant.id, 'admin@scoped.local', 'admin');

    const a = await makeRole(tenant.id, 'Role A');
    const b = await makeRole(tenant.id, 'Role B');
    await prisma.roleAssignment.create({ data: { roleId: b.role.id, userId: roleOwner.id, relation: 'owner' } });

    // Visible to `recruiter` by direct candidate assignment.
    const mine = await makeCandidate(tenant.id, a.role.id, 'Mine Assigned', recruiter.id);
    await makeSession({ tenantId: tenant.id, candidateId: mine.id, roleId: a.role.id, scorecardId: a.scorecard.id, state: 'REVIEW_READY', createdAt: ago(1), completedAt: ago(1) });
    const minePipe = await makePipeline({ tenantId: tenant.id, candidateId: mine.id, roleId: a.role.id, stage: 'silver' });
    await makeRound({ tenantId: tenant.id, pipelineId: minePipe.id, scheduledAt: ahead(2) });

    // Visible only to `roleOwner` (via role B) and admin.
    const other = await makeCandidate(tenant.id, b.role.id, 'Other Hidden');
    await makeSession({ tenantId: tenant.id, candidateId: other.id, roleId: b.role.id, scorecardId: b.scorecard.id, state: 'REVIEW_READY', createdAt: ago(2), completedAt: ago(2) });
    const otherPipe = await makePipeline({ tenantId: tenant.id, candidateId: other.id, roleId: b.role.id, stage: 'gold' });
    await makeRound({ tenantId: tenant.id, pipelineId: otherPipe.id, scheduledAt: ahead(2) });
    await makePipeline({ tenantId: tenant.id, candidateId: (await makeCandidate(tenant.id, b.role.id, 'Rejected Hidden')).id, roleId: b.role.id, stage: 'bronze', status: 'DECIDED', decision: 'REJECTED' });

    // Unassigned and on an unassigned role: admin only.
    await makeCandidate(tenant.id, a.role.id, 'Nobody Owns');

    return { recruiter, roleOwner, admin };
  }

  it('limits a directly-assigned recruiter to their own candidates', async () => {
    const { recruiter } = await seedScoped();
    const res = await getMetrics(recruiter.token);
    expect({
      candidates: res.body.kpis.candidates,
      awaitingReview: res.body.kpis.awaitingReview,
      activePipelines: res.body.kpis.activePipelines,
      scheduledNext7Days: res.body.kpis.scheduledNext7Days,
      completedLast30Days: res.body.kpis.completedLast30Days,
      decisions: res.body.kpis.decisions,
    }).toEqual({
      candidates: 1, awaitingReview: 1, activePipelines: 1, scheduledNext7Days: 1, completedLast30Days: 1,
      decisions: { APPROVED: 0, REJECTED: 0, WITHDRAWN: 0 },
    });
  });

  it('counts only assigned roles as open roles for a recruiter', async () => {
    const { recruiter } = await seedScoped();
    const res = await getMetrics(recruiter.token);
    expect(res.body.kpis.openRoles).toBe(0);
  });

  it("omits other recruiters' candidates from recent interviews", async () => {
    const { recruiter } = await seedScoped();
    const res = await getMetrics(recruiter.token);
    expect(res.body.recentInterviews.map((r: { candidate: { name: string } }) => r.candidate.name)).toEqual(['Mine Assigned']);
  });

  it('scopes the stage and state charts to visible candidates', async () => {
    const { recruiter } = await seedScoped();
    const res = await getMetrics(recruiter.token);
    const stageCounts = Object.fromEntries(res.body.pipelineStages.map((s: { key: string; count: number }) => [s.key, s.count]));
    expect({ silver: stageCounts.silver, gold: stageCounts.gold, states: res.body.stateCounts })
      .toEqual({ silver: 1, gold: 0, states: { REVIEW_READY: 1 } });
  });

  it('gives a role-assigned recruiter the candidates on that role', async () => {
    const { roleOwner } = await seedScoped();
    const res = await getMetrics(roleOwner.token);
    expect({ openRoles: res.body.kpis.openRoles, candidates: res.body.kpis.candidates, decisions: res.body.kpis.decisions })
      .toEqual({ openRoles: 1, candidates: 2, decisions: { APPROVED: 0, REJECTED: 1, WITHDRAWN: 0 } });
  });

  it('counts an AI round and the session it runs in as one interview', async () => {
    const tenant = await makeTenant('AI round tenant');
    const admin = await makeUser(tenant.id, 'ai.admin@m.local', 'admin');
    const { role, scorecard } = await makeRole(tenant.id, 'Engineer');
    const candidate = await makeCandidate(tenant.id, role.id, 'Ada Lovelace');
    const session = await makeSession({
      tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
      state: 'INVITED', scheduledAt: ahead(2),
    });
    const pipeline = await makePipeline({ tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, stage: 'silver' });
    // The Silver round IS that session; scheduling it must not add a second interview.
    await makeRound({
      tenantId: tenant.id, pipelineId: pipeline.id, scheduledAt: ahead(2),
      conductedBy: 'AI', sessionId: session.id,
    });

    const res = await getMetrics(admin.token);

    expect(res.body.kpis.scheduledNext7Days).toBe(1);
  });

  it('gives an admin the whole tenant', async () => {
    const { admin } = await seedScoped();
    const res = await getMetrics(admin.token);
    expect({ candidates: res.body.kpis.candidates, openRoles: res.body.kpis.openRoles, scheduled: res.body.kpis.scheduledNext7Days })
      .toEqual({ candidates: 4, openRoles: 2, scheduled: 2 });
  });
});
