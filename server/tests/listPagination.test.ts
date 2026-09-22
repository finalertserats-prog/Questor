import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * GET /candidates and GET /interviews are paged on the server: a page and a
 * page size from a fixed set, a stable order, a total that counts only what the
 * caller may see, and the text search applied before paging rather than in the
 * browser over whatever one page happened to load.
 */

const app = createApp();

interface Fixture {
  adminA: string;
  adminB: string;
  recruiterA: string;
  backendRoleId: string;
  designRoleId: string;
  firstBackendCandidateId: string;
}

const BACKEND_COUNT = 30;
const DESIGN_COUNT = 3;
const OTHER_TENANT_COUNT = 5;
// One shared instant, so the order has to come from the tiebreak, not the clock.
const SAME_INSTANT = new Date('2026-09-01T10:00:00.000Z');

const pad = (n: number): string => String(n).padStart(2, '0');

function bearer(user: { id: string; tenantId: string; email: string }, role: string): string {
  return `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role, email: user.email })}`;
}

async function setup(): Promise<Fixture> {
  await wipe();
  const tenantA = await prisma.tenant.create({ data: { name: 'Paging Org A' } });
  const tenantB = await prisma.tenant.create({ data: { name: 'Paging Org B' } });
  const adminA = await prisma.user.create({ data: { tenantId: tenantA.id, email: 'admin@a.paging', name: 'Admin A', passwordHash: 'x', role: 'admin' } });
  const adminB = await prisma.user.create({ data: { tenantId: tenantB.id, email: 'admin@b.paging', name: 'Admin B', passwordHash: 'x', role: 'admin' } });
  const recruiterA = await prisma.user.create({ data: { tenantId: tenantA.id, email: 'rec@a.paging', name: 'Rec A', passwordHash: 'x', role: 'recruiter' } });

  const backend = await prisma.role.create({ data: { tenantId: tenantA.id, title: 'Backend Engineer', status: 'approved' } });
  const design = await prisma.role.create({ data: { tenantId: tenantA.id, title: 'Product Designer', status: 'approved' } });
  const otherRole = await prisma.role.create({ data: { tenantId: tenantB.id, title: 'Backend Engineer', status: 'approved' } });
  await prisma.roleAssignment.create({ data: { roleId: design.id, userId: recruiterA.id } });
  const backendCard = await prisma.roleScorecardVersion.create({ data: { roleId: backend.id, version: 1, status: 'approved', profileJson: '{}' } });
  const designCard = await prisma.roleScorecardVersion.create({ data: { roleId: design.id, version: 1, status: 'approved', profileJson: '{}' } });
  const otherCard = await prisma.roleScorecardVersion.create({ data: { roleId: otherRole.id, version: 1, status: 'approved', profileJson: '{}' } });

  const backendIds: string[] = [];
  for (let i = 1; i <= BACKEND_COUNT; i += 1) {
    const email = `person${pad(i)}@a.paging`;
    const c = await prisma.candidate.create({
      data: { tenantId: tenantA.id, roleId: backend.id, fullName: `Person ${pad(i)}`, email, emailNormalized: email, createdAt: SAME_INSTANT },
    });
    backendIds.push(c.id);
    await prisma.interviewSession.create({
      data: { tenantId: tenantA.id, roleId: backend.id, scorecardId: backendCard.id, candidateId: c.id, state: i <= 5 ? 'INVITED' : 'REVIEW_READY', createdAt: SAME_INSTANT },
    });
  }
  await prisma.candidatePipeline.create({
    data: { tenantId: tenantA.id, candidateId: backendIds[0], roleId: backend.id, stagesJson: '[]', currentStageKey: 'silver' },
  });
  // Person 01 also applied to the design role: one person, two applications.
  const designNames = ['Zara Quinn', 'Yusuf Ortiz', 'Person 01'];
  for (const [index, name] of designNames.entries()) {
    const email = index === 2 ? 'person01@a.paging' : `design${index}@a.paging`;
    const c = await prisma.candidate.create({ data: { tenantId: tenantA.id, roleId: design.id, fullName: name, email, emailNormalized: email } });
    await prisma.interviewSession.create({ data: { tenantId: tenantA.id, roleId: design.id, scorecardId: designCard.id, candidateId: c.id, state: 'ASSESSING' } });
  }
  for (let i = 1; i <= OTHER_TENANT_COUNT; i += 1) {
    const email = `zara${i}@b.paging`;
    const c = await prisma.candidate.create({ data: { tenantId: tenantB.id, roleId: otherRole.id, fullName: `Zara Other ${i}`, email, emailNormalized: email } });
    await prisma.interviewSession.create({ data: { tenantId: tenantB.id, roleId: otherRole.id, scorecardId: otherCard.id, candidateId: c.id, state: 'INVITED' } });
  }

  return {
    adminA: bearer(adminA, 'admin'),
    adminB: bearer(adminB, 'admin'),
    recruiterA: bearer(recruiterA, 'recruiter'),
    backendRoleId: backend.id,
    designRoleId: design.id,
    firstBackendCandidateId: backendIds[0],
  };
}

let f: Fixture;
beforeAll(async () => { f = await setup(); });

const TENANT_A_TOTAL = BACKEND_COUNT + DESIGN_COUNT;

describe('GET /api/candidates paging', () => {
  it('returns 25 rows by default', async () => {
    const res = await request(app).get('/api/candidates').set('Authorization', f.adminA);
    expect(res.body.candidates).toHaveLength(25);
  });

  it('reports the total, page and page size in meta', async () => {
    const res = await request(app).get('/api/candidates').set('Authorization', f.adminA);
    expect(res.body.meta).toEqual({ total: TENANT_A_TOTAL, page: 1, pageSize: 25, limit: 25 });
  });

  it('returns the remainder on the second page', async () => {
    const res = await request(app).get('/api/candidates?page=2').set('Authorization', f.adminA);
    expect(res.body.candidates).toHaveLength(TENANT_A_TOTAL - 25);
  });

  it('accepts a page size of 50', async () => {
    const res = await request(app).get('/api/candidates?pageSize=50').set('Authorization', f.adminA);
    expect(res.body.candidates).toHaveLength(TENANT_A_TOTAL);
  });

  it('accepts a page size of 100', async () => {
    const res = await request(app).get('/api/candidates?pageSize=100').set('Authorization', f.adminA);
    expect(res.status).toBe(200);
  });

  it.each(['10', '0', '101', '-25', 'abc', '25.5'])('refuses page size %s', async (size) => {
    const res = await request(app).get(`/api/candidates?pageSize=${size}`).set('Authorization', f.adminA);
    expect(res.status).toBe(400);
  });

  it.each(['0', '-1', 'x', '1.5'])('refuses page %s', async (page) => {
    const res = await request(app).get(`/api/candidates?page=${page}`).set('Authorization', f.adminA);
    expect(res.status).toBe(400);
  });

  it('refuses a repeated page size', async () => {
    const res = await request(app).get('/api/candidates?pageSize=25&pageSize=50').set('Authorization', f.adminA);
    expect(res.status).toBe(400);
  });

  it('returns no rows past the last page, with the total still reported', async () => {
    const res = await request(app).get('/api/candidates?page=9').set('Authorization', f.adminA);
    expect({ rows: res.body.candidates.length, total: res.body.meta.total }).toEqual({ rows: 0, total: TENANT_A_TOTAL });
  });

  it('pages without overlap or gaps even when rows share a creation time', async () => {
    const [one, two] = await Promise.all([
      request(app).get('/api/candidates?page=1').set('Authorization', f.adminA),
      request(app).get('/api/candidates?page=2').set('Authorization', f.adminA),
    ]);
    const ids = [...one.body.candidates, ...two.body.candidates].map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(TENANT_A_TOTAL);
  });

  it('keeps the same order across repeated reads', async () => {
    const first = await request(app).get('/api/candidates?page=2').set('Authorization', f.adminA);
    const again = await request(app).get('/api/candidates?page=2').set('Authorization', f.adminA);
    expect(again.body.candidates.map((c: { id: string }) => c.id)).toEqual(first.body.candidates.map((c: { id: string }) => c.id));
  });

  it('counts only the caller\'s own tenant', async () => {
    const res = await request(app).get('/api/candidates').set('Authorization', f.adminB);
    expect(res.body.meta.total).toBe(OTHER_TENANT_COUNT);
  });

  it('counts only what a scoped recruiter may see', async () => {
    const res = await request(app).get('/api/candidates').set('Authorization', f.recruiterA);
    expect(res.body.meta.total).toBe(DESIGN_COUNT);
  });

  it('searches names case-insensitively before paging', async () => {
    const res = await request(app).get('/api/candidates?q=PERSON 1').set('Authorization', f.adminA);
    // Person 10..19
    expect(res.body.meta.total).toBe(10);
  });

  it('searches addresses', async () => {
    const res = await request(app).get('/api/candidates?q=design1@').set('Authorization', f.adminA);
    expect(res.body.candidates.map((c: { fullName: string }) => c.fullName)).toEqual(['Yusuf Ortiz']);
  });

  it('searches role titles', async () => {
    const res = await request(app).get('/api/candidates?q=product designer').set('Authorization', f.adminA);
    expect(res.body.meta.total).toBe(DESIGN_COUNT);
  });

  it('pages search results with the search total', async () => {
    const res = await request(app).get('/api/candidates?q=person&page=2').set('Authorization', f.adminA);
    // Thirty backend applications plus Person 01's design one.
    expect({ rows: res.body.candidates.length, total: res.body.meta.total }).toEqual({ rows: 6, total: 31 });
  });

  it('never finds another tenant\'s people', async () => {
    const res = await request(app).get('/api/candidates?q=zara other').set('Authorization', f.adminA);
    expect(res.body.meta.total).toBe(0);
  });

  it('searches only within a scoped recruiter\'s rows', async () => {
    const res = await request(app).get('/api/candidates?q=person').set('Authorization', f.recruiterA);
    expect(res.body.meta.total).toBe(1);
  });

  it('refuses an over-long search', async () => {
    const res = await request(app).get(`/api/candidates?q=${'a'.repeat(201)}`).set('Authorization', f.adminA);
    expect(res.status).toBe(400);
  });

  it('narrows by role within the caller\'s scope', async () => {
    const res = await request(app).get(`/api/candidates?roleId=${f.designRoleId}`).set('Authorization', f.adminA);
    expect(res.body.meta.total).toBe(DESIGN_COUNT);
  });

  it('a role filter cannot widen a scoped recruiter\'s view', async () => {
    const res = await request(app).get(`/api/candidates?roleId=${f.backendRoleId}`).set('Authorization', f.recruiterA);
    expect(res.body.meta.total).toBe(0);
  });

  it('counts latest interview states across every page, not just this one', async () => {
    const res = await request(app).get('/api/candidates').set('Authorization', f.adminA);
    expect(res.body.summary.latestStateCounts).toEqual({ INVITED: 5, REVIEW_READY: BACKEND_COUNT - 5, ASSESSING: DESIGN_COUNT });
  });

  it('counts other roles the same person is in', async () => {
    const res = await request(app).get('/api/candidates?q=person 01').set('Authorization', f.adminA);
    expect(res.body.candidates.map((c: { alsoInRoles: number }) => c.alsoInRoles)).toEqual([1, 1]);
  });

  it('does not count roles a scoped recruiter cannot see', async () => {
    const res = await request(app).get('/api/candidates?q=person 01').set('Authorization', f.recruiterA);
    expect(res.body.candidates[0].alsoInRoles).toBe(0);
  });

  it('names the pipeline stage a candidate has reached', async () => {
    const res = await request(app).get(`/api/candidates?q=person01@&roleId=${f.backendRoleId}`).set('Authorization', f.adminA);
    expect(res.body.candidates[0].stage).toEqual({ key: 'silver', label: 'Silver', decision: null });
  });

  it('gives no stage to a candidate without a pipeline', async () => {
    const res = await request(app).get(`/api/candidates?q=zara quinn`).set('Authorization', f.adminA);
    expect(res.body.candidates[0].stage).toBeNull();
  });

  it('names the roles a page needs to label same-titled roles apart', async () => {
    const res = await request(app).get(`/api/candidates?roleId=${f.designRoleId}`).set('Authorization', f.adminA);
    expect(res.body.roles.map((r: { id: string }) => r.id)).toEqual([f.designRoleId]);
  });
});

describe('GET /api/interviews paging', () => {
  it('returns 25 sessions by default', async () => {
    const res = await request(app).get('/api/interviews').set('Authorization', f.adminA);
    expect(res.body.sessions).toHaveLength(25);
  });

  it('reports the total in meta', async () => {
    const res = await request(app).get('/api/interviews').set('Authorization', f.adminA);
    expect(res.body.meta).toEqual({ total: TENANT_A_TOTAL, page: 1, pageSize: 25, limit: 25 });
  });

  it.each(['7', '0', '1000', 'all'])('refuses page size %s', async (size) => {
    const res = await request(app).get(`/api/interviews?pageSize=${size}`).set('Authorization', f.adminA);
    expect(res.status).toBe(400);
  });

  it('pages without overlap', async () => {
    const [one, two] = await Promise.all([
      request(app).get('/api/interviews?page=1').set('Authorization', f.adminA),
      request(app).get('/api/interviews?page=2').set('Authorization', f.adminA),
    ]);
    const ids = [...one.body.sessions, ...two.body.sessions].map((s: { id: string }) => s.id);
    expect(new Set(ids).size).toBe(TENANT_A_TOTAL);
  });

  it('counts only the caller\'s tenant', async () => {
    const res = await request(app).get('/api/interviews').set('Authorization', f.adminB);
    expect(res.body.meta.total).toBe(OTHER_TENANT_COUNT);
  });

  it('counts only a scoped recruiter\'s sessions', async () => {
    const res = await request(app).get('/api/interviews').set('Authorization', f.recruiterA);
    expect(res.body.meta.total).toBe(DESIGN_COUNT);
  });

  it('filters by state on the server', async () => {
    const res = await request(app).get('/api/interviews?states=INVITED,ASSESSING').set('Authorization', f.adminA);
    expect(res.body.meta.total).toBe(5 + DESIGN_COUNT);
  });

  it('refuses a malformed state', async () => {
    const res = await request(app).get('/api/interviews?states=invited;drop').set('Authorization', f.adminA);
    expect(res.status).toBe(400);
  });

  it('searches candidate names case-insensitively', async () => {
    const res = await request(app).get('/api/interviews?q=zara').set('Authorization', f.adminA);
    expect(res.body.sessions.map((s: { candidate: { name: string } }) => s.candidate.name)).toEqual(['Zara Quinn']);
  });

  it('searches role titles', async () => {
    const res = await request(app).get('/api/interviews?q=backend').set('Authorization', f.adminA);
    expect(res.body.meta.total).toBe(BACKEND_COUNT);
  });

  it('never finds another tenant\'s sessions', async () => {
    const res = await request(app).get('/api/interviews?q=zara other').set('Authorization', f.adminA);
    expect(res.body.meta.total).toBe(0);
  });

  it('narrows to one candidate', async () => {
    const res = await request(app).get(`/api/interviews?candidateId=${f.firstBackendCandidateId}`).set('Authorization', f.adminA);
    expect(res.body.sessions.map((s: { candidate: { id: string } }) => s.candidate.id)).toEqual([f.firstBackendCandidateId]);
  });

  it('a candidate filter cannot reach outside a scoped recruiter\'s view', async () => {
    const res = await request(app).get(`/api/interviews?candidateId=${f.firstBackendCandidateId}`).set('Authorization', f.recruiterA);
    expect(res.body.meta.total).toBe(0);
  });
});
