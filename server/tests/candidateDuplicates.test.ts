import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { eraseAllApplications } from '../src/services/personErasure.js';

/**
 * One person, one application per role; and erasing a person means every
 * application they have in the organisation.
 *
 * Add candidate refuses a second application for the same address on the
 * same role, pointing at the one already there, as "Set up for another role"
 * always has. Erasure can take every application for the address at once,
 * each through the single-row path, and a row under legal hold is left alone.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let adminId = '';
let adminToken = '';
let recruiterToken = '';
let otherTenantId = '';
let dataRoleId = '';
let platformRoleId = '';
let analyticsRoleId = '';

async function makeRole(token: string, title: string): Promise<string> {
  const res = await request(app).post('/api/roles').set(auth(token))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title, useLlm: false });
  return res.body.role.id as string;
}

const addCandidate = (token: string, body: { fullName: string; email: string; roleId: string }) =>
  request(app).post('/api/candidates').set(auth(token)).send(body);

const erase = (token: string, candidateId: string, body: Record<string, unknown>) =>
  request(app).delete(`/api/candidates/${candidateId}`).set(auth(token)).send(body);

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@dupes.local', password: 'fixture-admin-passphrase', name: 'Admin', tenantName: 'Dupes Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;
  adminId = reg.body.user.id;
  const recruiter = await prisma.user.create({ data: { tenantId, email: 'recruiter@dupes.local', name: 'Rec', passwordHash: 'x', role: 'recruiter' } });
  recruiterToken = signToken({ userId: recruiter.id, tenantId, role: 'recruiter', email: recruiter.email });

  dataRoleId = await makeRole(recruiterToken, 'Senior Data Engineer');
  platformRoleId = await makeRole(recruiterToken, 'Platform Engineer');
  analyticsRoleId = await makeRole(recruiterToken, 'Analytics Lead');

  const other = await request(app).post('/api/auth/register').send({
    email: 'admin@elsewhere.local', password: 'fixture-other-passphrase', name: 'Other', tenantName: 'Elsewhere Org',
  });
  otherTenantId = other.body.user.tenantId;
});

describe('POST /api/candidates for an address already on the role', () => {
  let firstId = '';

  beforeAll(async () => {
    firstId = (await addCandidate(recruiterToken, { fullName: 'Asha Rao', email: 'asha@example.com', roleId: dataRoleId })).body.candidate.id;
  });

  it('answers 409 naming the application already there', async () => {
    const res = await addCandidate(recruiterToken, { fullName: 'Asha Rao', email: 'asha@example.com', roleId: dataRoleId });

    expect({ status: res.status, code: res.body.code, candidateId: res.body.candidateId }).toEqual({ status: 409, code: 'candidate_exists', candidateId: firstId });
  });

  it('treats a differently capitalised address as the same person', async () => {
    const res = await addCandidate(recruiterToken, { fullName: 'Asha Rao', email: '  ASHA@Example.com ', roleId: dataRoleId });

    expect(res.status).toBe(409);
  });

  it('writes no second row', async () => {
    expect(await prisma.candidate.count({ where: { roleId: dataRoleId, emailNormalized: 'asha@example.com' } })).toBe(1);
  });

  it('still adds the same address to a different role', async () => {
    const res = await addCandidate(recruiterToken, { fullName: 'Asha Rao', email: 'asha@example.com', roleId: platformRoleId });

    expect(res.status).toBe(201);
  });

  it('creates exactly one application when the same add arrives twice at once', async () => {
    const body = { fullName: 'Twice Over', email: 'twice@example.com', roleId: dataRoleId };

    const statuses = (await Promise.all([addCandidate(recruiterToken, body), addCandidate(recruiterToken, body)])).map((r) => r.status).sort();

    expect({ statuses, rows: await prisma.candidate.count({ where: { roleId: dataRoleId, emailNormalized: 'twice@example.com' } }) }).toEqual({ statuses: [201, 409], rows: 1 });
  });

  it('gives a refused add no pipeline, owner or audit entry of its own', async () => {
    const before = await prisma.auditEvent.count({ where: { tenantId, action: 'candidate.created' } });

    await addCandidate(recruiterToken, { fullName: 'Asha Rao', email: 'asha@example.com', roleId: dataRoleId });

    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'candidate.created' } })).toBe(before);
  });
});

describe('DELETE /api/candidates/:id with allApplications', () => {
  const EMAIL = 'meera@example.com';
  let dataApp = '';
  let platformApp = '';
  let analyticsApp = '';
  let otherTenantRow = '';
  let otherPersonRow = '';

  beforeAll(async () => {
    dataApp = (await addCandidate(recruiterToken, { fullName: 'Meera Iyer', email: EMAIL, roleId: dataRoleId })).body.candidate.id;
    platformApp = (await addCandidate(recruiterToken, { fullName: 'Meera Iyer', email: 'Meera@Example.com', roleId: platformRoleId })).body.candidate.id;
    analyticsApp = (await addCandidate(recruiterToken, { fullName: 'Meera Iyer', email: EMAIL, roleId: analyticsRoleId })).body.candidate.id;
    otherPersonRow = (await addCandidate(recruiterToken, { fullName: 'Someone Else', email: 'else@example.com', roleId: dataRoleId })).body.candidate.id;
    // The same address in another organisation is another organisation's record.
    const otherRole = await prisma.role.create({ data: { tenantId: otherTenantId, title: 'Their role', status: 'approved' } });
    otherTenantRow = (await prisma.candidate.create({ data: { tenantId: otherTenantId, roleId: otherRole.id, fullName: 'Meera Iyer', email: EMAIL, emailNormalized: EMAIL } })).id;
    // One application has an interview under legal hold.
    const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: analyticsRoleId } });
    await prisma.interviewSession.create({ data: { tenantId, candidateId: analyticsApp, roleId: analyticsRoleId, scorecardId: scorecard.id, legalHold: true } });
  });

  it('GET /:id tells an admin how many other applications the person has', async () => {
    const res = await request(app).get(`/api/candidates/${dataApp}`).set(auth(adminToken));

    expect(res.body.otherApplications).toBe(2);
  });

  it('GET /:id does not tell a recruiter, who cannot erase', async () => {
    const res = await request(app).get(`/api/candidates/${dataApp}`).set(auth(recruiterToken));

    expect(res.body.otherApplications).toBeUndefined();
  });

  it('refuses a recruiter, who lacks candidate:erase', async () => {
    const res = await erase(recruiterToken, dataApp, { reason: 'Asked to be forgotten.', allApplications: true });

    expect(res.status).toBe(403);
  });

  it('refuses an allApplications that is not a boolean', async () => {
    const res = await erase(adminToken, dataApp, { reason: 'Asked to be forgotten.', allApplications: 'yes' });

    expect(res.status).toBe(400);
  });

  describe('once run', () => {
    let res: request.Response;

    beforeAll(async () => {
      res = await erase(adminToken, dataApp, { reason: 'Asked to be forgotten.', allApplications: true });
    });

    it('answers with the erased and skipped counts', () => {
      expect({ status: res.status, erased: res.body.erased, erasedCount: res.body.erasedCount, skippedCount: res.body.skippedCount })
        .toEqual({ status: 200, erased: true, erasedCount: 2, skippedCount: 1 });
    });

    it('names the application it skipped and why', () => {
      expect(res.body.skipped).toEqual([{ candidateId: analyticsApp, reason: 'legal_hold' }]);
    });

    it('erases every application for the address that is not held', async () => {
      expect(await prisma.candidate.count({ where: { id: { in: [dataApp, platformApp] } } })).toBe(0);
    });

    it('never erases the application under legal hold', async () => {
      expect(await prisma.interviewSession.count({ where: { candidateId: analyticsApp, legalHold: true } })).toBe(1);
    });

    it('leaves the same address in another organisation untouched', async () => {
      expect(await prisma.candidate.count({ where: { id: otherTenantRow } })).toBe(1);
    });

    it('leaves other people untouched', async () => {
      expect(await prisma.candidate.count({ where: { id: otherPersonRow } })).toBe(1);
    });

    it('writes the single-row erasure audit entry for each erased application', async () => {
      const entries = await prisma.auditEvent.findMany({ where: { tenantId, action: 'candidate.erased' }, select: { entityId: true } });

      expect(entries.map((e) => e.entityId).sort()).toEqual([dataApp, platformApp].sort());
    });

    it('writes one summary entry, naming the actor and without the reason text', async () => {
      const entries = await prisma.auditEvent.findMany({ where: { tenantId, action: 'candidate.erased_all_applications' } });

      expect(entries.map((e) => ({ actorId: e.actorId, entityId: e.entityId, after: JSON.parse(e.afterJson) }))).toEqual([{
        actorId: adminId,
        entityId: dataApp,
        // The requested application is erased last.
        after: { reasonProvided: true, erasedCount: 2, skippedCount: 1, failedCount: 0, erasedIds: [platformApp, dataApp], skippedIds: [analyticsApp], failedIds: [] },
      }]);
    });
  });

  it('skips the asked-for application itself when it is held, and says it was not erased', async () => {
    const res = await erase(adminToken, analyticsApp, { reason: 'Asked to be forgotten.', allApplications: true });

    expect({ status: res.status, erased: res.body.erased, erasedCount: res.body.erasedCount, skippedCount: res.body.skippedCount })
      .toEqual({ status: 200, erased: false, erasedCount: 0, skippedCount: 1 });
  });

  it('also erases a row written before the normalised address existed', async () => {
    const current = (await addCandidate(recruiterToken, { fullName: 'Old Row', email: 'oldrow@example.com', roleId: dataRoleId })).body.candidate.id;
    const legacy = await prisma.candidate.create({ data: { tenantId, roleId: platformRoleId, fullName: 'Old Row', email: ' OldRow@Example.com' } });

    const res = await erase(adminToken, current, { reason: 'Asked to be forgotten.', allApplications: true });

    expect({ erasedCount: res.body.erasedCount, left: await prisma.candidate.count({ where: { id: legacy.id } }) }).toEqual({ erasedCount: 2, left: 0 });
  });

  it('without allApplications erases only the one application', async () => {
    const one = (await addCandidate(recruiterToken, { fullName: 'Ravi K', email: 'ravi@example.com', roleId: dataRoleId })).body.candidate.id;
    const two = (await addCandidate(recruiterToken, { fullName: 'Ravi K', email: 'ravi@example.com', roleId: platformRoleId })).body.candidate.id;

    await erase(adminToken, one, { reason: 'Asked to be forgotten.' });

    expect(await prisma.candidate.count({ where: { id: two } })).toBe(1);
  });
});

describe('eraseAllApplications within a caller scope', () => {
  it('leaves applications outside the scope it is given', async () => {
    const email = 'scoped@example.com';
    const inScope = (await addCandidate(recruiterToken, { fullName: 'Scoped Person', email, roleId: dataRoleId })).body.candidate.id as string;
    const outOfScope = (await addCandidate(recruiterToken, { fullName: 'Scoped Person', email, roleId: platformRoleId })).body.candidate.id as string;

    await eraseAllApplications({ tenantId, candidateId: inScope, actorId: adminId, reason: 'Asked to be forgotten.', scope: { roleId: dataRoleId } });

    expect(await prisma.candidate.findUnique({ where: { id: outOfScope } })).not.toBeNull();
  });
});
