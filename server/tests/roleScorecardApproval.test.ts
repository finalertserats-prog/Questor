import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';

/**
 * Who may read a requisition, and what exactly an approval approves.
 *
 * Approval used to take whatever version happened to be latest when the
 * request arrived, so a manager reviewing v2 could approve a v3 someone saved
 * a second earlier without ever seeing it. The client now names the version it
 * reviewed.
 */

const app = createApp();
// Not a credential: bcrypt-hashed locally for fixture users that never log in.
const FIXTURE_PASSPHRASE = 'not-a-real-passphrase-fixture';

let tenantId = '';
let adminToken = '';
let roleId = '';
const tokens: Record<string, string> = {};
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function makeUser(role: string, email: string): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({ data: { email, name: email, passwordHash: hashPassword(FIXTURE_PASSPHRASE), role, tenantId } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function latestScorecard() {
  return prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId }, orderBy: { version: 'desc' } });
}

async function editScorecard(token: string) {
  const current = await latestScorecard();
  return request(app).put(`/api/roles/${roleId}/scorecard`).set(auth(token)).send({ profile: JSON.parse(current.profileJson) });
}

const approve = (token: string, body: object) => request(app).post(`/api/roles/${roleId}/approve`).set(auth(token)).send(body);

beforeEach(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@roles.local', password: 'fixture-admin-passphrase', name: 'Roles Admin', tenantName: 'Roles Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;

  const role = await request(app).post('/api/roles').set(auth(adminToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  roleId = role.body.role.id;

  for (const name of ['recruiter', 'manager', 'reviewer', 'auditor', 'manager2']) {
    const user = await makeUser(name === 'manager2' ? 'manager' : name, `${name}@roles.local`);
    tokens[name] = user.token;
    await request(app).post(`/api/admin/users/${user.id}/roles/${roleId}`).set(auth(adminToken)).send({});
  }
  tokens.admin = adminToken;
});

describe('reading requisitions', () => {
  for (const name of ['recruiter', 'manager', 'reviewer', 'admin']) {
    it(`lets a ${name} list, open and validate an assigned role`, async () => {
      const statuses = [
        (await request(app).get('/api/roles').set(auth(tokens[name]))).status,
        (await request(app).get(`/api/roles/${roleId}`).set(auth(tokens[name]))).status,
        (await request(app).get(`/api/roles/${roleId}/validate`).set(auth(tokens[name]))).status,
      ];

      expect(statuses).toEqual([200, 200, 200]);
    });
  }

  it('refuses an auditor, whose job is the audit trail and not requisition content', async () => {
    const statuses = [
      (await request(app).get('/api/roles').set(auth(tokens.auditor))).status,
      (await request(app).get(`/api/roles/${roleId}`).set(auth(tokens.auditor))).status,
      (await request(app).get(`/api/roles/${roleId}/validate`).set(auth(tokens.auditor))).status,
    ];

    expect(statuses).toEqual([403, 403, 403]);
  });
});

describe('approving a scorecard', () => {
  it('requires the client to say which version it is approving', async () => {
    const res = await approve(tokens.manager, {});

    expect(res.status).toBe(400);
  });

  it('approves the version the client names when it is still the latest draft', async () => {
    const sc = await latestScorecard();

    const res = await approve(tokens.manager, { scorecardId: sc.id, version: sc.version });

    expect([res.status, res.body.scorecard?.id]).toEqual([200, sc.id]);
  });

  it('refuses when a newer version was saved after the approver looked', async () => {
    const reviewed = await latestScorecard();
    await approve(tokens.admin, { scorecardId: reviewed.id, version: reviewed.version });
    await editScorecard(tokens.recruiter); // creates v2 as a new draft

    const res = await approve(tokens.manager, { scorecardId: reviewed.id, version: reviewed.version });

    expect(res.status).toBe(409);
  });

  it('refuses a version number that does not match the named scorecard', async () => {
    const sc = await latestScorecard();

    const res = await approve(tokens.manager, { scorecardId: sc.id, version: sc.version + 1 });

    expect(res.status).toBe(409);
  });

  it('refuses to approve a version that is already approved', async () => {
    const sc = await latestScorecard();
    await approve(tokens.manager, { scorecardId: sc.id, version: sc.version });

    const res = await approve(tokens.manager2, { scorecardId: sc.id, version: sc.version });

    expect(res.status).toBe(409);
  });

  it('refuses a manager approving a draft they last edited themselves', async () => {
    await editScorecard(tokens.manager);
    const sc = await latestScorecard();

    const res = await approve(tokens.manager, { scorecardId: sc.id, version: sc.version });

    expect(res.status).toBe(403);
  });

  it('lets a different manager approve that draft', async () => {
    await editScorecard(tokens.manager);
    const sc = await latestScorecard();

    const res = await approve(tokens.manager2, { scorecardId: sc.id, version: sc.version });

    expect(res.status).toBe(200);
  });

  it('lets an admin approve a draft they edited', async () => {
    await editScorecard(tokens.admin);
    const sc = await latestScorecard();

    const res = await approve(tokens.admin, { scorecardId: sc.id, version: sc.version });

    expect(res.status).toBe(200);
  });
});
