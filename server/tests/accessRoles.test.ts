import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';

// Object-level authorization on /api/roles and /api/candidates.
//
// The regression these cover: every route used to filter on tenantId alone, so
// any authenticated user in the tenant could read and mutate every requisition
// and every candidate. A capability check alone would not have closed it —
// `candidate:read` says a recruiter may read candidates, not that they may read
// THIS one. Both halves are asserted here.

const app = createApp();

// Not a credential: bcrypt-hashed locally for fixture users that never log in.
// Only `signToken` output is used to authenticate them.
const FIXTURE_PASSPHRASE = 'not-a-real-passphrase-fixture';

let tenantId = '';
let adminToken = '';
let recruiterAToken = '';
let recruiterBToken = '';
let roleAId = '';
let candidateAId = '';
let orphanRoleId = '';

/** Create a tenant user at `role` and return a bearer token for them. */
async function makeUser(role: string, email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email, name: email, passwordHash: hashPassword(FIXTURE_PASSPHRASE), role, tenantId },
  });
  return signToken({ userId: user.id, tenantId, role, email });
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  // wipe() predates the assignment tables and does not clear them; their FKs to
  // Role/Candidate would make its deleteMany calls fail.
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();

  // The first user of a new tenant is its admin (auth/register hard-codes it).
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@access.local',
    password: 'fixture-admin-passphrase',
    name: 'Access Admin',
    tenantName: 'Access Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;

  recruiterAToken = await makeUser('recruiter', 'recruiter-a@access.local');
  recruiterBToken = await makeUser('recruiter', 'recruiter-b@access.local');

  // Recruiter A's own requisition and pipeline.
  const roleRes = await request(app).post('/api/roles').set(auth(recruiterAToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  roleAId = roleRes.body.role.id;

  const candRes = await request(app).post('/api/candidates').set(auth(recruiterAToken))
    .send({ fullName: 'Priya Sharma', email: 'priya@example.com', roleId: roleAId });
  candidateAId = candRes.body.candidate.id;

  // Recruiter B owns a requisition of their own. This matters: with an EMPTY
  // assignment list a scope filter of `id IN ()` denies everything, so a
  // deny-test against a user who owns nothing passes even against a broken
  // check. B must have something in scope for these assertions to mean anything.
  await request(app).post('/api/roles').set(auth(recruiterBToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Platform Engineer', useLlm: false });

  // A role with no assignment rows at all — created straight through Prisma so
  // it bypasses the route that would have granted ownership.
  const orphan = await prisma.role.create({
    data: {
      tenantId, title: 'Unassigned Role', level: 'senior', location: '', employmentType: 'full-time',
      sourceType: 'paste', sourceText: DEMO_JD, status: 'draft',
    },
  });
  orphanRoleId = orphan.id;
});

describe('role scope', () => {
  it('does not list another recruiter\'s role', async () => {
    const res = await request(app).get('/api/roles').set(auth(recruiterBToken));
    expect(res.body.roles.map((r: { id: string }) => r.id)).not.toContain(roleAId);
  });

  it('returns 404 rather than 403 when reading another recruiter\'s role', async () => {
    // 403 would confirm the id exists, which is itself a disclosure.
    const res = await request(app).get(`/api/roles/${roleAId}`).set(auth(recruiterBToken));
    expect(res.status).toBe(404);
  });

  it('lets the creator read the role they created', async () => {
    const res = await request(app).get(`/api/roles/${roleAId}`).set(auth(recruiterAToken));
    expect(res.status).toBe(200);
  });

  it('lets an admin read a role they were never assigned', async () => {
    const res = await request(app).get(`/api/roles/${roleAId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('refuses a non-owner editing the scorecard', async () => {
    const res = await request(app).put(`/api/roles/${roleAId}/scorecard`).set(auth(recruiterBToken))
      .send({ profile: { competencies: [] } });
    expect(res.status).toBe(404);
  });

  it('refuses a non-owner running JD validation', async () => {
    const res = await request(app).get(`/api/roles/${roleAId}/validate`).set(auth(recruiterBToken));
    expect(res.status).toBe(404);
  });
});

describe('unassigned objects resolve to admin-only', () => {
  it('hides an unassigned role from a recruiter', async () => {
    // The dangerous default would be "unowned means visible to everyone" — it
    // preserves the original exposure while looking like it works.
    const res = await request(app).get(`/api/roles/${orphanRoleId}`).set(auth(recruiterAToken));
    expect(res.status).toBe(404);
  });

  it('still shows an unassigned role to an admin', async () => {
    const res = await request(app).get(`/api/roles/${orphanRoleId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
  });
});

describe('scorecard approval is separated from authorship', () => {
  it('refuses to let a recruiter approve a scorecard', async () => {
    // Recruiters hold role:edit_scorecard but not role:approve_scorecard —
    // approving the scorecard you authored is the control being added here.
    const res = await request(app).post(`/api/roles/${roleAId}/approve`).set(auth(recruiterAToken)).send({});
    expect(res.status).toBe(403);
  });

  it('lets a manager-capability holder approve it', async () => {
    const res = await request(app).post(`/api/roles/${roleAId}/approve`).set(auth(adminToken)).send({});
    expect(res.status).toBe(200);
  });
});

describe('candidate scope', () => {
  it('does not list another recruiter\'s candidate', async () => {
    const res = await request(app).get('/api/candidates').set(auth(recruiterBToken));
    expect(res.body.candidates.map((c: { id: string }) => c.id)).not.toContain(candidateAId);
  });

  it('ignores a roleId query param pointing at an out-of-scope role', async () => {
    // roleId is ANDed with scope, so it can only narrow — it used to be the
    // entire filter, which made it a pipeline-enumeration parameter.
    const res = await request(app).get(`/api/candidates?roleId=${roleAId}`).set(auth(recruiterBToken));
    expect(res.body.candidates).toHaveLength(0);
  });

  it('returns 404 when another recruiter reads the candidate directly', async () => {
    const res = await request(app).get(`/api/candidates/${candidateAId}`).set(auth(recruiterBToken));
    expect(res.status).toBe(404);
  });

  it('lets the creator read the candidate they created', async () => {
    const res = await request(app).get(`/api/candidates/${candidateAId}`).set(auth(recruiterAToken));
    expect(res.status).toBe(200);
  });

  it('lets an admin read a candidate they were never assigned', async () => {
    const res = await request(app).get(`/api/candidates/${candidateAId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('refuses a resume upload against another recruiter\'s candidate', async () => {
    const res = await request(app).post(`/api/candidates/${candidateAId}/resume`)
      .set(auth(recruiterBToken)).field('text', 'Some resume text');
    expect(res.status).toBe(404);
  });

  it('refuses to create a candidate under another recruiter\'s role', async () => {
    const res = await request(app).post('/api/candidates').set(auth(recruiterBToken))
      .send({ fullName: 'Planted Record', email: 'planted@example.com', roleId: roleAId });
    expect(res.status).toBe(404);
  });
});

describe('erasure', () => {
  it('refuses erasure to a recruiter, who lacks candidate:erase', async () => {
    const res = await request(app).delete(`/api/candidates/${candidateAId}`)
      .set(auth(recruiterAToken)).send({ reason: 'candidate requested erasure' });
    expect(res.status).toBe(403);
  });

  it('allows erasure by an admin', async () => {
    const res = await request(app).delete(`/api/candidates/${candidateAId}`)
      .set(auth(adminToken)).send({ reason: 'candidate requested erasure' });
    expect(res.status).toBe(200);
  });
});
