import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';
import { signToken, verifyToken } from '../src/services/auth.js';
import { scorecardForFit } from '../src/services/scorecards.js';
import { fingerprint } from '../src/middleware/rateLimit.js';

/**
 * Findings from the security and silent-failure reviews on the candidate
 * routes and their neighbours, pinned.
 */

const app = createApp();

/** The approve body: approval names the version the approver reviewed. */
async function reviewedScorecard(roleId: string) {
  const sc = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId }, orderBy: { version: 'desc' } });
  return { scorecardId: sc.id, version: sc.version };
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let adminToken = '';
let recruiterToken = '';
let reviewerToken = '';
let auditorToken = '';
let roleId = '';
let candidateId = '';

async function makeUser(email: string, role: string) {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@hardening.local', password: 'fixture-admin-passphrase', name: 'Admin', tenantName: 'Hardening Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;
  recruiterToken = (await makeUser('recruiter@hardening.local', 'recruiter')).token;
  auditorToken = (await makeUser('auditor@hardening.local', 'auditor')).token;
  const reviewer = await makeUser('reviewer@hardening.local', 'reviewer');
  reviewerToken = reviewer.token;

  const roleRes = await request(app).post('/api/roles').set(auth(recruiterToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  roleId = roleRes.body.role.id;
  const candRes = await request(app).post('/api/candidates').set(auth(recruiterToken))
    .send({ fullName: 'Priya Sharma', email: 'priya@example.com', roleId });
  candidateId = candRes.body.candidate.id;
  await prisma.candidateAssignment.create({ data: { candidateId, userId: reviewer.id, relation: 'reviewer' } });
});

describe('who may read and write candidate detail', () => {
  it('refuses an auditor listing candidates', async () => {
    expect((await request(app).get('/api/candidates').set(auth(auditorToken))).status).toBe(403);
  });

  it('refuses an auditor reading one candidate', async () => {
    expect((await request(app).get(`/api/candidates/${candidateId}`).set(auth(auditorToken))).status).toBe(403);
  });

  it('refuses a reviewer uploading a resume, even for a candidate they are assigned to review', async () => {
    const res = await request(app).post(`/api/candidates/${candidateId}/resume`).set(auth(reviewerToken))
      .send({ text: 'Ten years of Spark, Airflow and Snowflake at scale.' });

    expect(res.status).toBe(403);
  });

  it('still lets the recruiter who owns the candidate upload a resume', async () => {
    const res = await request(app).post(`/api/candidates/${candidateId}/resume`).set(auth(recruiterToken))
      .send({ text: 'Ten years of Spark, Airflow and Snowflake at scale. Led data platform teams.' });

    expect(res.status).toBe(201);
  });
});

describe('which scorecard a resume is scored against', () => {
  it('prefers the approved version over a newer draft', async () => {
    await request(app).post(`/api/roles/${roleId}/approve`).set(auth(adminToken)).send(await reviewedScorecard(roleId));
    const approved = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId, status: 'approved' } });
    await prisma.roleScorecardVersion.create({ data: { roleId, version: approved.version + 1, status: 'draft', profileJson: approved.profileJson } });

    const chosen = await scorecardForFit(roleId);

    expect(chosen?.id).toBe(approved.id);
  });

  it('falls back to the newest draft when nothing is approved', async () => {
    const other = await request(app).post('/api/roles').set(auth(recruiterToken))
      .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Platform Engineer', useLlm: false });
    const first = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: other.body.role.id } });
    const second = await prisma.roleScorecardVersion.create({ data: { roleId: other.body.role.id, version: first.version + 1, status: 'draft', profileJson: first.profileJson } });

    const chosen = await scorecardForFit(other.body.role.id);

    expect(chosen?.id).toBe(second.id);
  });

  it('answers null for a candidate with no role', async () => {
    expect(await scorecardForFit(null)).toBeNull();
  });
});

describe('comparing other roles when the applied role has no fit', () => {
  it('says there is no baseline rather than calling every alternative stronger', async () => {
    const profile = await prisma.candidateProfileVersion.findFirstOrThrow({ where: { candidateId }, orderBy: { version: 'desc' } });
    await prisma.candidateProfileVersion.update({ where: { id: profile.id }, data: { fitScoreJson: '{}' } });
    // The applied role's approved scorecard would otherwise be rescored live;
    // withdraw its approval so the only baseline is the stored (empty) fit.
    await prisma.roleScorecardVersion.updateMany({ where: { roleId }, data: { status: 'draft' } });

    const res = await request(app).get(`/api/candidates/${candidateId}/profile-analysis`).set(auth(recruiterToken));

    const claims = (res.body.alternativeRoles as Array<{ why: string }>).map((a) => a.why).join(' ');
    expect(claims).not.toMatch(/points stronger/);
  });
});

describe('a job description sent to the model', () => {
  it('is refused when it is longer than any real posting', async () => {
    const res = await request(app).post('/api/roles').set(auth(recruiterToken))
      .send({ sourceType: 'paste', sourceText: 'x'.repeat(50_001), useLlm: false });

    expect(res.status).toBe(400);
  });
});

describe('what the rate limiter writes to the log', () => {
  it('is not the key itself', () => {
    expect(fingerprint('t:secret-invitation-token')).not.toContain('secret-invitation-token');
  });

  it('is stable for the same key', () => {
    expect(fingerprint('t:abc')).toBe(fingerprint('t:abc'));
  });
});

describe('session tokens', () => {
  it('rejects a token signed with no algorithm', () => {
    const unsigned = jwt.sign({ userId: 'u', tenantId: 't', role: 'admin', email: 'a@b.c' }, '', { algorithm: 'none' });

    expect(verifyToken(unsigned)).toBeNull();
  });
});

describe('filtering the candidate list', () => {
  it('answers 400, not 500, when roleId is given more than once', async () => {
    const res = await request(app).get(`/api/candidates?roleId=${roleId}&roleId=${roleId}`).set(auth(adminToken));

    expect(res.status).toBe(400);
  });

  it('still filters by a single roleId', async () => {
    const res = await request(app).get(`/api/candidates?roleId=${roleId}`).set(auth(adminToken));

    expect(res.status).toBe(200);
  });
});
