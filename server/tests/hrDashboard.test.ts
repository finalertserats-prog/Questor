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

async function makeReviewedAssessment(o: {
  sessionId: string;
  scorecardId: string;
  reviewerId: string;
  disposition: 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS';
}) {
  const assessment = await prisma.assessmentVersion.create({
    data: { sessionId: o.sessionId, scorecardId: o.scorecardId, recommendation: o.disposition, resultJson: '{}' },
  });
  await prisma.humanReview.create({
    data: {
      assessmentId: assessment.id, reviewerId: o.reviewerId, status: 'COMPLETED',
      disposition: o.disposition, reason: 'reviewed', completedAt: new Date(),
    },
  });
  return assessment;
}

beforeEach(async () => {
  await wipe();
});

describe('GET /api/admin/hr-dashboard', () => {
  it('composes pipeline, agreement and review-disposition sections in one response', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Dashboard Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@dash.local');
    const { role, scorecard } = await makeRoleSet(tenant.id);

    const one = await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'One', email: 'one@dash.local', state: 'REVIEW_READY', assignToUserId: recruiter.id,
    });
    await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'Two', email: 'two@dash.local', state: 'INVITED', assignToUserId: recruiter.id,
    });
    await makeReviewedAssessment({
      sessionId: one.session.id, scorecardId: scorecard.id, reviewerId: recruiter.id, disposition: 'PROCEED',
    });

    const res = await request(app)
      .get('/api/admin/hr-dashboard')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('pipeline');
    expect(res.body).toHaveProperty('agreement');
    expect(res.body).toHaveProperty('reviewDispositions');

    expect(res.body.pipeline).toEqual({ stateCounts: { REVIEW_READY: 1, INVITED: 1 }, total: 2 });
    expect(res.body.reviewDispositions).toEqual({ PROCEED: 1, CONSIDER: 0, DO_NOT_PROGRESS: 0 });

    // The agreement report is the exact object shape getAgreementReport
    // produces (see services/shadowMode.ts) — assert on its stable fields
    // rather than the whole object, since generatedAt is a timestamp.
    expect(res.body.agreement).toHaveProperty('sampleSize');
    expect(res.body.agreement).toHaveProperty('disposition');
    expect(res.body.agreement).toHaveProperty('gate');
  });

  it('does not require pipeline-summary or shadow-metrics to be called separately', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Single Call Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@single.local');

    const res = await request(app)
      .get('/api/admin/hr-dashboard')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(res.status).toBe(200);
    expect(res.body.pipeline).toEqual({ stateCounts: {}, total: 0 });
    expect(res.body.reviewDispositions).toEqual({ PROCEED: 0, CONSIDER: 0, DO_NOT_PROGRESS: 0 });
  });

  it('scopes the pipeline and review-disposition sections to candidates the caller may see', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Scoped Dashboard Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@scoped.local');
    const { role, scorecard } = await makeRoleSet(tenant.id);

    // Assigned to the recruiter — must be visible.
    const visible = await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'Visible', email: 'visible@scoped.local', state: 'HUMAN_REVIEWED', assignToUserId: recruiter.id,
    });
    await makeReviewedAssessment({
      sessionId: visible.session.id, scorecardId: scorecard.id, reviewerId: recruiter.id, disposition: 'CONSIDER',
    });

    // NOT assigned to the recruiter and not on an assigned role — must be hidden.
    const hidden = await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'Hidden', email: 'hidden@scoped.local', state: 'HUMAN_REVIEWED',
    });
    await makeReviewedAssessment({
      sessionId: hidden.session.id, scorecardId: scorecard.id, reviewerId: recruiter.id, disposition: 'DO_NOT_PROGRESS',
    });

    const recruiterView = await request(app)
      .get('/api/admin/hr-dashboard')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(recruiterView.status).toBe(200);
    expect(recruiterView.body.pipeline).toEqual({ stateCounts: { HUMAN_REVIEWED: 1 }, total: 1 });
    expect(recruiterView.body.reviewDispositions).toEqual({ PROCEED: 0, CONSIDER: 1, DO_NOT_PROGRESS: 0 });

    // An admin sees the whole tenant, hidden candidate included.
    const admin = await makeUser(tenant.id, 'admin@scoped.local', 'admin');
    const adminView = await request(app)
      .get('/api/admin/hr-dashboard')
      .set('Authorization', `Bearer ${admin.token}`);

    expect(adminView.status).toBe(200);
    expect(adminView.body.pipeline).toEqual({ stateCounts: { HUMAN_REVIEWED: 2 }, total: 2 });
    expect(adminView.body.reviewDispositions).toEqual({ PROCEED: 0, CONSIDER: 1, DO_NOT_PROGRESS: 1 });
  });

  it('denies a role without assessment:read', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Denied Org' } });
    // 'auditor' holds audit:read but not assessment:read (see domain/capabilities.ts).
    const auditor = await makeUser(tenant.id, 'auditor@denied.local', 'auditor');

    const res = await request(app)
      .get('/api/admin/hr-dashboard')
      .set('Authorization', `Bearer ${auditor.token}`);

    expect(res.status).toBe(403);
  });
});

describe('GET /api/interviews/pipeline-summary CSV export', () => {
  it('returns CSV with a state,count header when format=csv is set', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'CSV Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@csv.local');
    const { role, scorecard } = await makeRoleSet(tenant.id);

    await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'One', email: 'one@csv.local', state: 'PROVISIONED', assignToUserId: recruiter.id,
    });
    await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'Two', email: 'two@csv.local', state: 'INVITED', assignToUserId: recruiter.id,
    });

    const res = await request(app)
      .get('/api/interviews/pipeline-summary?format=csv')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const lines = res.text.trim().split('\n');
    expect(lines[0]).toBe('state,count');
    expect(lines).toContain('PROVISIONED,1');
    expect(lines).toContain('INVITED,1');
    expect(lines).toHaveLength(3);
  });

  it('keeps returning JSON by default when format is not given', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'JSON Default Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@jsondefault.local');
    const { role, scorecard } = await makeRoleSet(tenant.id);

    await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'One', email: 'one@jsondefault.local', state: 'PROVISIONED', assignToUserId: recruiter.id,
    });

    const res = await request(app)
      .get('/api/interviews/pipeline-summary')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({ stateCounts: { PROVISIONED: 1 }, total: 1 });
  });

  it('neutralises spreadsheet formulas in exported cells', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'CSV Injection Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@csvinj.local');
    const { role, scorecard } = await makeRoleSet(tenant.id);
    await makeCandidateSession({
      tenantId: tenant.id, roleId: role.id, scorecardId: scorecard.id,
      fullName: 'One', email: 'one@csvinj.local', state: '=HYPERLINK("http://evil.example","x")', assignToUserId: recruiter.id,
    });

    const res = await request(app)
      .get('/api/interviews/pipeline-summary?format=csv')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(res.text.trim().split('\n')[1]).toBe(`"'=HYPERLINK(""http://evil.example"",""x"")",1`);
  });

  it('rejects an unrecognised format value', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Bad Format Org' } });
    const recruiter = await makeUser(tenant.id, 'recruiter@badformat.local');

    const res = await request(app)
      .get('/api/interviews/pipeline-summary?format=xml')
      .set('Authorization', `Bearer ${recruiter.token}`);

    expect(res.status).toBe(400);
  });
});
