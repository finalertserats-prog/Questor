import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { eraseCandidate } from '../src/services/dataRights.js';
import { installFakeAts, type FakeAtsHost } from './fakeAts.js';

// Codex auth #5 and #6: requisition import and assessment export reached one
// deployment-wide ATS, and the export target was whatever id the caller sent.
// Every call now goes to the caller's own ATS, and exports go only to a
// candidate's stored link.

const app = createApp();
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

const KEY_A = 'ats-key-A-MARKER';
const KEY_B = 'ats-key-B-MARKER';
const JD = 'Senior Data Engineer. Requirements: 5+ years with SQL and Python, Spark and Airflow.';

const HOST_A: FakeAtsHost = {
  requisitions: { 'REQ-1': { title: 'Data Engineer', description: JD } },
  candidates: { 'C-1': { fullName: 'Asha Rao', email: 'asha@example.com', phone: '' }, 'C-2': { fullName: 'Ben Ode', email: 'ben@example.com' }, 'C-NOMAIL': { fullName: 'No Mail' } },
};
const HOST_B: FakeAtsHost = {
  requisitions: {},
  candidates: { 'C-B1': { fullName: 'Chen Li', email: 'chen@example.com' } },
};

interface Fixture {
  adminA: string; adminB: string; recruiterA: string;
  tenantA: string; tenantB: string;
  candidateA: string; assessmentA: string; roleA: string;
  candidateB: string; assessmentB: string; roleB: string;
}

async function scoredAssessment(sessionId: string, scorecardId: string) {
  const row = await prisma.assessmentVersion.create({
    data: {
      sessionId, scorecardId, recommendation: 'CONSIDER',
      resultJson: JSON.stringify({ recommendation: 'CONSIDER', overallScore: 71, confidence: 0.7, competencies: [] }),
    },
  });
  return row.id;
}

async function setup(): Promise<Fixture> {
  await wipe();
  const demo = await createDemoData();
  const adminA = (await request(app).post('/api/auth/login').send({ email: demo.email, password: demo.password })).body.token as string;
  const reg = await request(app).post('/api/auth/register').send({ email: 'admin@iso-b.local', password: 'iso-b-long-password', name: 'B', tenantName: 'Iso B' });
  const adminB = reg.body.token as string;
  const tenantB = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@iso-b.local' } })).tenantId;

  await request(app).post('/api/admin/users').set(as(adminA)).send({ email: 'rec@iso-a.local', password: 'iso-a-long-password', name: 'Rec', role: 'recruiter' });
  const recruiterA = (await request(app).post('/api/auth/login').send({ email: 'rec@iso-a.local', password: 'iso-a-long-password' })).body.token as string;

  // Tenant B's own role, candidate, interview and scored assessment.
  const roleB = await prisma.role.create({ data: { tenantId: tenantB, title: 'B role', status: 'approved' } });
  const scorecardB = await prisma.roleScorecardVersion.create({ data: { roleId: roleB.id, version: 1, status: 'approved', profileJson: '{}' } });
  const candidateB = await prisma.candidate.create({ data: { tenantId: tenantB, roleId: roleB.id, fullName: 'Chen Li', email: 'chen@example.com' } });
  const sessionB = await prisma.interviewSession.create({ data: { tenantId: tenantB, candidateId: candidateB.id, roleId: roleB.id, scorecardId: scorecardB.id } });

  return {
    adminA, adminB, recruiterA, tenantA: demo.tenantId, tenantB,
    candidateA: demo.candidateId, assessmentA: await scoredAssessment(demo.sessionId, demo.scorecardId), roleA: demo.roleId,
    candidateB: candidateB.id, assessmentB: await scoredAssessment(sessionB.id, scorecardB.id), roleB: roleB.id,
  };
}

const connect = (token: string, host: string, apiKey: string) =>
  request(app).put('/api/admin/ats').set(as(token)).send({ baseUrl: `https://${host}/api`, apiKey });

const importRole = (token: string, atsRequisitionId: string) =>
  request(app).post('/api/roles').set(as(token)).send({ sourceType: 'ats', atsRequisitionId, useLlm: false });

const setLink = (token: string, candidateId: string, externalCandidateId: string) =>
  request(app).put(`/api/candidates/${candidateId}/ats-link`).set(as(token)).send({ externalCandidateId });

const exportAssessment = (token: string, id: string, body: object = {}) =>
  request(app).post(`/api/assessments/${id}/export`).set(as(token)).send(body);

let fx: Fixture;
let fake: ReturnType<typeof installFakeAts>;

beforeEach(async () => {
  config.ats.baseUrl = '';
  config.ats.tenantId = '';
  fx = await setup();
  fake = installFakeAts({ 'ats-a.example.com': HOST_A, 'ats-b.example.com': HOST_B, 'ats-c.example.com': {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requisition import', () => {
  it('tells an organisation with no ATS that it has none, without calling any ATS', async () => {
    const res = await importRole(fx.adminA, 'REQ-1');
    expect({ status: res.status, code: res.body.code, calls: fake.calls.length }).toEqual({ status: 409, code: 'ATS_NOT_CONNECTED', calls: 0 });
  });

  it("imports from the caller's own ATS with the caller's key", async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importRole(fx.adminA, 'REQ-1');
    expect({ status: res.status, host: fake.calls[0].url.host, auth: fake.calls[0].authorization })
      .toEqual({ status: 201, host: 'ats-a.example.com', auth: `Bearer ${KEY_A}` });
  });

  it('records which requisition became which role', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importRole(fx.adminA, 'REQ-1');
    const row = await prisma.atsRequisitionImport.findFirstOrThrow({ where: { externalRequisitionId: 'REQ-1' } });
    expect({ tenantId: row.tenantId, roleId: row.roleId }).toEqual({ tenantId: fx.tenantA, roleId: res.body.role.id });
  });

  it('answers a repeat import with the same role', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const first = await importRole(fx.adminA, 'REQ-1');
    const again = await importRole(fx.adminA, 'REQ-1');
    expect({ status: again.status, same: again.body.role.id === first.body.role.id, flagged: again.body.alreadyImported })
      .toEqual({ status: 200, same: true, flagged: true });
  });

  it('does not create a second role or call the ATS again on a repeat', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await importRole(fx.adminA, 'REQ-1');
    const callsAfterFirst = fake.calls.length;
    await importRole(fx.adminA, 'REQ-1');
    const roles = await prisma.role.count({ where: { tenantId: fx.tenantA, sourceType: 'ats' } });
    expect({ roles, newCalls: fake.calls.length - callsAfterFirst }).toEqual({ roles: 1, newCalls: 0 });
  });

  it('makes one role when two imports of the same requisition race', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const results = await Promise.all([importRole(fx.adminA, 'REQ-1'), importRole(fx.adminA, 'REQ-1')]);
    const roles = await prisma.role.count({ where: { tenantId: fx.tenantA, sourceType: 'ats' } });
    expect({ roles, statuses: results.map((r) => r.status).sort() }).toEqual({ roles: 1, statuses: [200, 201] });
  });

  it("sends tenant B's import to tenant B's ATS, never to A's", async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await connect(fx.adminB, 'ats-b.example.com', KEY_B);
    const res = await importRole(fx.adminB, 'REQ-1');
    expect({ status: res.status, hosts: fake.hostsCalled() }).toEqual({ status: 422, hosts: ['ats-b.example.com'] });
  });

  it("refuses tenant B a requisition tenant A already imported, even once B holds A's former account", async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await importRole(fx.adminA, 'REQ-1');
    // A moves to another ATS account, freeing the old one; B then connects it.
    await connect(fx.adminA, 'ats-c.example.com', KEY_A);
    await connect(fx.adminB, 'ats-a.example.com', KEY_B);

    const res = await importRole(fx.adminB, 'REQ-1');

    const bRoles = await prisma.role.count({ where: { tenantId: fx.tenantB, sourceType: 'ats' } });
    expect({ status: res.status, leakedRole: res.body.role, bRoles }).toEqual({ status: 409, leakedRole: undefined, bRoles: 0 });
  });

  it('refuses a requisition id shaped like a path', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importRole(fx.adminA, '../admin');
    expect({ status: res.status, calls: fake.calls.length }).toEqual({ status: 400, calls: 0 });
  });

  it('asks for the requisition id when it is missing', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await request(app).post('/api/roles').set(as(fx.adminA)).send({ sourceType: 'ats', sourceText: JD, useLlm: false });
    expect(res.status).toBe(400);
  });

  it('reports an ATS outage without the vendor body', async () => {
    fake = installFakeAts({ 'ats-a.example.com': { failWith: 503 } });
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importRole(fx.adminA, 'REQ-1');
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 502, error: expect.stringMatching(/could not be reached/) });
  });
});

describe('export goes only to the stored link', () => {
  it('refuses an export for a candidate with no link, without calling the ATS', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await exportAssessment(fx.adminA, fx.assessmentA);
    expect({ status: res.status, code: res.body.code, calls: fake.calls.length }).toEqual({ status: 409, code: 'ATS_LINK_MISSING', calls: 0 });
  });

  it('refuses an export when the organisation has no ATS', async () => {
    const res = await exportAssessment(fx.adminA, fx.assessmentA);
    expect(res.body.code).toBe('ATS_NOT_CONNECTED');
  });

  it('refuses a request that names the ATS candidate itself', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    const before = fake.calls.length;
    const res = await exportAssessment(fx.adminA, fx.assessmentA, { externalCandidateId: 'C-2' });
    expect({ status: res.status, newCalls: fake.calls.length - before }).toEqual({ status: 400, newCalls: 0 });
  });

  it('pushes to the linked ATS candidate with the tenant key', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    const res = await exportAssessment(fx.adminA, fx.assessmentA);
    const push = fake.calls.find((c) => c.method === 'POST');
    expect({ status: res.status, path: push?.url.pathname, auth: push?.authorization })
      .toEqual({ status: 200, path: '/api/candidates/C-1/assessments', auth: `Bearer ${KEY_A}` });
  });

  it("sends tenant B's export to tenant B's ATS only", async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await connect(fx.adminB, 'ats-b.example.com', KEY_B);
    await setLink(fx.adminB, fx.candidateB, 'C-B1');
    const res = await exportAssessment(fx.adminB, fx.assessmentB);
    expect({ status: res.status, hosts: fake.hostsCalled() }).toEqual({ status: 200, hosts: ['ats-b.example.com'] });
  });

  it("does not let tenant B export tenant A's assessment", async () => {
    await connect(fx.adminB, 'ats-b.example.com', KEY_B);
    const res = await exportAssessment(fx.adminB, fx.assessmentA);
    expect({ status: res.status, calls: fake.calls.filter((c) => c.method === 'POST').length }).toEqual({ status: 404, calls: 0 });
  });
});

describe('setting a candidate link', () => {
  it('checks the id exists in the organisation ATS', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await setLink(fx.adminA, fx.candidateA, 'C-404');
    const links = await prisma.candidateAtsLink.count();
    expect({ status: res.status, links }).toEqual({ status: 422, links: 0 });
  });

  it('checks it in the caller ATS, not another tenant ATS', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await connect(fx.adminB, 'ats-b.example.com', KEY_B);
    const res = await setLink(fx.adminB, fx.candidateB, 'C-1');
    expect({ status: res.status, hosts: fake.hostsCalled() }).toEqual({ status: 422, hosts: ['ats-b.example.com'] });
  });

  it('shows the link to an admin', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    const res = await request(app).get(`/api/candidates/${fx.candidateA}/ats-link`).set(as(fx.adminA));
    expect({ connected: res.body.connected, id: res.body.link?.externalCandidateId, source: res.body.link?.source })
      .toEqual({ connected: true, id: 'C-1', source: 'manual' });
  });

  it('is refused to a recruiter', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await setLink(fx.recruiterA, fx.candidateA, 'C-1');
    expect(res.status).toBe(403);
  });

  it("is refused on another tenant's candidate", async () => {
    await connect(fx.adminB, 'ats-b.example.com', KEY_B);
    const res = await setLink(fx.adminB, fx.candidateA, 'C-B1');
    expect(res.status).toBe(404);
  });

  it('refuses an id shaped like a path', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await setLink(fx.adminA, fx.candidateA, 'C-1/../../admin');
    expect({ status: res.status, calls: fake.calls.length }).toEqual({ status: 400, calls: 0 });
  });

  it('refuses one ATS candidate linked to two candidates', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const other = await prisma.candidate.create({ data: { tenantId: fx.tenantA, roleId: fx.roleA, fullName: 'Other', email: 'o@example.com' } });
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    const res = await setLink(fx.adminA, other.id, 'C-1');
    expect(res.status).toBe(409);
  });

  it('is audited without the external id', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    const row = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'candidate.ats_link.set', entityId: fx.candidateA } });
    expect(row.afterJson).not.toContain('C-1');
  });

  it('can be removed by an admin', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    await request(app).delete(`/api/candidates/${fx.candidateA}/ats-link`).set(as(fx.adminA));
    expect(await prisma.candidateAtsLink.count({ where: { candidateId: fx.candidateA } })).toBe(0);
  });

  it('goes when the organisation moves to a different ATS account', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    await connect(fx.adminA, 'ats-c.example.com', KEY_A);
    expect(await prisma.candidateAtsLink.count({ where: { candidateId: fx.candidateA } })).toBe(0);
  });
});

describe('importing a candidate from the ATS', () => {
  const importCandidate = (token: string, externalCandidateId: string, roleId: string) =>
    request(app).post('/api/candidates/import-ats').set(as(token)).send({ externalCandidateId, roleId });

  it('creates the candidate with a link to the record it came from', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importCandidate(fx.adminA, 'C-2', fx.roleA);
    const link = await prisma.candidateAtsLink.findFirstOrThrow({ where: { candidateId: res.body.candidate.id } });
    expect({ status: res.status, id: link.externalCandidateId, source: link.source }).toEqual({ status: 201, id: 'C-2', source: 'import' });
  });

  it('answers a repeat import with the same candidate', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const first = await importCandidate(fx.adminA, 'C-2', fx.roleA);
    const again = await importCandidate(fx.adminA, 'C-2', fx.roleA);
    expect({ status: again.status, same: again.body.candidate.id === first.body.candidate.id }).toEqual({ status: 200, same: true });
  });

  it('refuses a record with no usable email', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importCandidate(fx.adminA, 'C-NOMAIL', fx.roleA);
    expect(res.status).toBe(422);
  });

  it("refuses a role in another tenant", async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importCandidate(fx.adminA, 'C-2', fx.roleB);
    expect({ status: res.status, calls: fake.calls.length }).toEqual({ status: 404, calls: 0 });
  });

  it('lets an exported assessment reach the imported record', async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    const res = await importCandidate(fx.adminA, 'C-1', fx.roleA);
    const session = await prisma.interviewSession.findFirstOrThrow({ where: { candidateId: fx.candidateA } });
    await prisma.interviewSession.update({ where: { id: session.id }, data: { candidateId: res.body.candidate.id } });
    const out = await exportAssessment(fx.adminA, fx.assessmentA);
    expect(out.status).toBe(200);
  });
});

describe('erasure', () => {
  it("removes the candidate's ATS link", async () => {
    await connect(fx.adminA, 'ats-a.example.com', KEY_A);
    await setLink(fx.adminA, fx.candidateA, 'C-1');
    const user = await prisma.user.findFirstOrThrow({ where: { tenantId: fx.tenantA, role: 'admin' } });

    const result = await eraseCandidate({ tenantId: fx.tenantA, candidateId: fx.candidateA, actorId: user.id, reason: 'Asked to be forgotten.' });

    expect({ links: await prisma.candidateAtsLink.count(), counted: result.deleted.atsLinks }).toEqual({ links: 0, counted: 1 });
  });
});
