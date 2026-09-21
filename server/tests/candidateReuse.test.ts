import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD, DEMO_RESUME } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * Candidate reuse: one person, several roles, never typed twice.
 *
 * A Candidate row stays "this person's application to this role". Search finds
 * the people the caller may already see; apply copies one of them onto another
 * role as a new, independent row.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let adminToken = '';
let recruiterId = '';
let recruiterToken = '';
let otherRecruiterToken = '';
let auditorToken = '';
let dataRoleId = '';
let platformRoleId = '';
let otherRoleId = '';
let priyaId = '';

async function makeUser(email: string, role: string) {
  const user = await prisma.user.create({ data: { tenantId, email, name: email, passwordHash: 'x', role } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId, role, email }) };
}

async function makeRole(token: string, title: string): Promise<string> {
  const res = await request(app).post('/api/roles').set(auth(token))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title, useLlm: false });
  return res.body.role.id as string;
}

async function addCandidate(token: string, body: { fullName: string; email: string; roleId: string; phone?: string }): Promise<string> {
  const res = await request(app).post('/api/candidates').set(auth(token)).send(body);
  return res.body.candidate.id as string;
}

const search = (token: string, q: string) => request(app).get(`/api/candidates/search?q=${encodeURIComponent(q)}`).set(auth(token));
const apply = (token: string, candidateId: string, roleId: string) =>
  request(app).post(`/api/candidates/${candidateId}/apply`).set(auth(token)).send({ roleId });

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@reuse.local', password: 'fixture-admin-passphrase', name: 'Admin', tenantName: 'Reuse Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;
  const recruiter = await makeUser('recruiter@reuse.local', 'recruiter');
  recruiterId = recruiter.id;
  recruiterToken = recruiter.token;
  otherRecruiterToken = (await makeUser('other@reuse.local', 'recruiter')).token;
  auditorToken = (await makeUser('auditor@reuse.local', 'auditor')).token;

  dataRoleId = await makeRole(recruiterToken, 'Senior Data Engineer');
  platformRoleId = await makeRole(recruiterToken, 'Platform Engineer');
  otherRoleId = await makeRole(otherRecruiterToken, 'Analytics Lead');

  priyaId = await addCandidate(recruiterToken, { fullName: 'Priya Sharma', email: '  Priya.Sharma@Example.com ', roleId: dataRoleId, phone: '+91 98765 43210' });
  await request(app).post(`/api/candidates/${priyaId}/resume`).set(auth(recruiterToken)).send({ text: DEMO_RESUME });
  // The same person, also in a pipeline the recruiter cannot see.
  await addCandidate(otherRecruiterToken, { fullName: 'Priya Sharma', email: 'priya.sharma@example.com', roleId: otherRoleId });
  // Only in the other recruiter's pipeline.
  await addCandidate(otherRecruiterToken, { fullName: 'Hidden Person', email: 'hidden@example.com', roleId: otherRoleId });
});

describe('what a new candidate row stores for its address', () => {
  it('keeps the address trimmed and lowercased beside the one typed', async () => {
    const row = await prisma.candidate.findUniqueOrThrow({ where: { id: priyaId } });

    expect(row.emailNormalized).toBe('priya.sharma@example.com');
  });
});

describe('the backfill for rows written before the column existed', () => {
  it('fills the normalised address from the stored one', async () => {
    const row = await prisma.candidate.create({ data: { tenantId, roleId: dataRoleId, fullName: 'Legacy Row', email: ' Legacy@Example.COM' } });
    const migration = readFileSync(join(process.cwd(), 'prisma', 'postgres', 'migrations', '20260921100000_candidate_email_normalized', 'migration.sql'), 'utf8');
    const backfill = migration.split(';').map((s) => s.replace(/^\s*--.*$/gm, '').trim()).find((s) => s.startsWith('UPDATE'));

    await prisma.$executeRawUnsafe(backfill!);

    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: row.id } })).emailNormalized).toBe('legacy@example.com');
    await prisma.candidate.delete({ where: { id: row.id } });
  });
});

describe('GET /api/candidates/search', () => {
  it('refuses a query shorter than two characters', async () => {
    expect((await search(recruiterToken, 'p')).status).toBe(400);
  });

  it('refuses an auditor, who holds no candidate detail', async () => {
    expect((await search(auditorToken, 'priya')).status).toBe(403);
  });

  it('finds a person by part of their name, ignoring case', async () => {
    const res = await search(recruiterToken, 'SHAR');

    expect(res.body.people.map((p: { fullName: string }) => p.fullName)).toEqual(['Priya Sharma']);
  });

  it('finds a person by their address, ignoring case', async () => {
    const res = await search(recruiterToken, 'Priya.Sharma@EXAMPLE');

    expect(res.body.people).toHaveLength(1);
  });

  it('lists only the roles the caller can see the person in', async () => {
    const res = await search(recruiterToken, 'priya');

    expect(res.body.people[0].roles.map((r: { roleId: string }) => r.roleId)).toEqual([dataRoleId]);
  });

  it('shows an admin every role the person is in', async () => {
    const res = await search(adminToken, 'priya');

    expect(res.body.people[0].roles.map((r: { roleId: string }) => r.roleId).sort()).toEqual([dataRoleId, otherRoleId].sort());
  });

  it('never returns a person only in a pipeline the caller cannot see', async () => {
    const res = await search(recruiterToken, 'hidden');

    expect(res.body.people).toEqual([]);
  });

  it('points at the application that has a resume, so applying carries it over', async () => {
    const res = await search(adminToken, 'priya');

    expect(res.body.people[0]).toMatchObject({ candidateId: priyaId, hasResume: true });
  });

  it('never returns another organisation’s candidates', async () => {
    const other = await request(app).post('/api/auth/register').send({
      email: 'admin@elsewhere.local', password: 'fixture-admin-passphrase', name: 'Else', tenantName: 'Elsewhere Org',
    });

    const res = await search(other.body.token, 'priya');

    expect(res.body.people).toEqual([]);
  });

  it('returns at most ten people', async () => {
    for (let i = 0; i < 12; i++) await addCandidate(recruiterToken, { fullName: `Bulk Person ${i}`, email: `bulk${i}@example.com`, roleId: dataRoleId });

    const res = await search(recruiterToken, 'bulk person');

    expect(res.body.people).toHaveLength(10);
  });
});

describe('POST /api/candidates/:id/apply', () => {
  let appliedId = '';

  beforeAll(async () => {
    const res = await apply(recruiterToken, priyaId, platformRoleId);
    appliedId = res.body.candidate?.id ?? '';
  });

  it('creates a new application on the target role', async () => {
    const row = await prisma.candidate.findUniqueOrThrow({ where: { id: appliedId } });

    expect(row).toMatchObject({ roleId: platformRoleId, fullName: 'Priya Sharma', phone: '+91 98765 43210', emailNormalized: 'priya.sharma@example.com' });
  });

  it('leaves the earlier application where it was', async () => {
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: priyaId } })).roleId).toBe(dataRoleId);
  });

  it('makes the person who applied them the owner', async () => {
    const owner = await prisma.candidateAssignment.findFirst({ where: { candidateId: appliedId, relation: 'owner' } });

    expect(owner?.userId).toBe(recruiterId);
  });

  it('carries the latest resume over as a new profile of its own', async () => {
    const [source, copy] = await Promise.all([
      prisma.candidateProfileVersion.findFirstOrThrow({ where: { candidateId: priyaId }, orderBy: { createdAt: 'desc' } }),
      prisma.candidateProfileVersion.findFirstOrThrow({ where: { candidateId: appliedId } }),
    ]);

    expect({ rawText: copy.rawText, version: copy.version, sameRow: copy.id === source.id }).toEqual({ rawText: source.rawText, version: 1, sameRow: false });
  });

  it('keeps a resume file record for the new application', async () => {
    expect(await prisma.artifact.count({ where: { candidateId: appliedId, kind: 'resume' } })).toBe(1);
  });

  it('builds the evidence graph for the new application', async () => {
    const copy = await prisma.candidateProfileVersion.findFirstOrThrow({ where: { candidateId: appliedId } });

    expect(await prisma.evidenceNode.count({ where: { profileId: copy.id } })).toBeGreaterThan(0);
  });

  it('starts the new role’s pipeline at the resume-review stage', async () => {
    const pipeline = await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId: appliedId } });

    expect({ roleId: pipeline.roleId, stage: pipeline.currentStageKey }).toEqual({ roleId: platformRoleId, stage: 'bronze' });
  });

  it('records where the details were copied from', async () => {
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: appliedId, action: 'candidate.created' } });

    expect(JSON.parse(event.afterJson)).toMatchObject({ copiedFromCandidateId: priyaId, roleId: platformRoleId });
  });

  it('answers 409 with the existing application when the person is already on that role', async () => {
    const res = await apply(recruiterToken, priyaId, platformRoleId);

    expect({ status: res.status, candidateId: res.body.candidateId, code: res.body.code }).toEqual({ status: 409, candidateId: appliedId, code: 'candidate_exists' });
  });

  it('treats a differently capitalised address as the same person', async () => {
    const shouty = await prisma.candidate.create({ data: { tenantId, roleId: dataRoleId, fullName: 'Shouty', email: 'SHOUTY@example.com', emailNormalized: 'shouty@example.com' } });
    await prisma.candidateAssignment.create({ data: { candidateId: shouty.id, userId: recruiterId, relation: 'owner' } });
    await prisma.candidate.create({ data: { tenantId, roleId: platformRoleId, fullName: 'Shouty', email: 'shouty@example.com', emailNormalized: 'shouty@example.com' } });

    expect((await apply(recruiterToken, shouty.id, platformRoleId)).status).toBe(409);
  });

  it('creates exactly one application when the same apply arrives twice at once', async () => {
    const fresh = await addCandidate(recruiterToken, { fullName: 'Twice Over', email: 'twice@example.com', roleId: dataRoleId });

    const statuses = (await Promise.all([apply(recruiterToken, fresh, platformRoleId), apply(recruiterToken, fresh, platformRoleId)])).map((r) => r.status).sort();

    expect({ statuses, rows: await prisma.candidate.count({ where: { roleId: platformRoleId, emailNormalized: 'twice@example.com' } }) }).toEqual({ statuses: [201, 409], rows: 1 });
  });

  it('applies a person without a resume, leaving them at the first stage', async () => {
    const fresh = await addCandidate(recruiterToken, { fullName: 'No Resume', email: 'noresume@example.com', roleId: dataRoleId });

    const res = await apply(recruiterToken, fresh, platformRoleId);
    const pipeline = await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId: res.body.candidate.id } });

    expect({ profileCopied: res.body.profileCopied, stage: pipeline.currentStageKey }).toEqual({ profileCopied: false, stage: 'participation' });
  });

  it('answers 404 for a candidate the caller cannot see', async () => {
    const hidden = await prisma.candidate.findFirstOrThrow({ where: { email: 'hidden@example.com' } });

    expect((await apply(recruiterToken, hidden.id, platformRoleId)).status).toBe(404);
  });

  it('answers 404 for a role the caller cannot see', async () => {
    expect((await apply(recruiterToken, priyaId, otherRoleId)).status).toBe(404);
  });

  it('refuses an archived role', async () => {
    const archived = await makeRole(recruiterToken, 'Archived Role');
    await prisma.role.update({ where: { id: archived }, data: { status: 'archived' } });

    expect((await apply(recruiterToken, priyaId, archived)).status).toBe(409);
  });

  it('refuses a caller who may not add candidates', async () => {
    expect((await apply(auditorToken, priyaId, platformRoleId)).status).toBe(403);
  });

  it('refuses a body without a role', async () => {
    expect((await request(app).post(`/api/candidates/${priyaId}/apply`).set(auth(recruiterToken)).send({})).status).toBe(400);
  });
});
