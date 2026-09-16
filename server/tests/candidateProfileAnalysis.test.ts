import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import type { RoleSuccessProfile } from '../src/domain/types.js';

const app = createApp();
const FIXTURE_PASSPHRASE = 'candidate-profile-fixture';
let tenantId = '';
let recruiterAToken = '';
let recruiterBToken = '';
let adminToken = '';
let otherTenantToken = '';
let userAId = '';
let userBId = '';
let candidateId = '';
let currentRoleId = '';
let betterRoleId = '';
let unassignedRoleId = '';
let otherTenantRoleId = '';
let noResumeCandidateId = '';
let singleRoleCandidateId = '';
let singleRoleToken = '';

function auth(token: string) { return { Authorization: `Bearer ${token}` }; }

function profile(names: string[], outcomes: string[] = []): RoleSuccessProfile {
  return {
    roleContext: `Needs ${names.join(', ')}`,
    outcomes,
    responsibilities: names.map((n) => `Own ${n}`),
    competencies: names.map((name, i) => ({
      id: `c-${name.toLowerCase().replace(/\s+/g, '-')}-${i}`,
      name,
      category: i === 0 ? 'technical' : 'domain',
      classification: i === 0 ? 'essential' : 'preferred',
      requiredLevel: 3,
      interviewGuidance: '',
    })),
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
    redFlags: [],
    seniority: 'senior',
  };
}

async function makeUser(role: string, email: string, tenant = tenantId): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({ data: { tenantId: tenant, email, name: email, role, passwordHash: hashPassword(FIXTURE_PASSPHRASE) } });
  return { id: user.id, token: signToken({ userId: user.id, tenantId: tenant, role, email }) };
}

async function makeApprovedRole(title: string, tenant: string, roleProfile: RoleSuccessProfile, assigneeId?: string) {
  const role = await prisma.role.create({ data: { tenantId: tenant, title, status: 'approved', sourceText: title } });
  await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(roleProfile) } });
  if (assigneeId) await prisma.roleAssignment.create({ data: { roleId: role.id, userId: assigneeId, relation: 'owner' } });
  return role.id;
}

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();

  const reg = await request(app).post('/api/auth/register').send({
    email: 'profile-admin@questor.local', password: 'fixture-admin-passphrase', name: 'Profile Admin', tenantName: 'Profile Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;

  const userA = await makeUser('recruiter', 'profile-a@questor.local');
  const userB = await makeUser('recruiter', 'profile-b@questor.local');
  userAId = userA.id; recruiterAToken = userA.token;
  userBId = userB.id; recruiterBToken = userB.token;

  currentRoleId = await makeApprovedRole('Backend Engineer', tenantId, profile(['Java', 'Spring'], ['ship APIs']), userAId);
  betterRoleId = await makeApprovedRole('Data Platform Engineer', tenantId, profile(['Python', 'Spark', 'Airflow'], ['build data pipelines']), userAId);
  unassignedRoleId = await makeApprovedRole('Secret Executive Role', tenantId, profile(['Python', 'Spark', 'Airflow'], ['secret data platform']));
  await makeApprovedRole('Recruiter B Private Role', tenantId, profile(['Python', 'Spark', 'Airflow'], ['private data role']), userBId);

  const other = await request(app).post('/api/auth/register').send({
    email: 'other-profile-admin@questor.local', password: 'fixture-other-passphrase', name: 'Other', tenantName: 'Other Profile Org',
  });
  otherTenantToken = other.body.token;
  const otherTenantId = other.body.user.tenantId;
  otherTenantRoleId = await makeApprovedRole('Other Tenant Data Role', otherTenantId, profile(['Python', 'Spark', 'Airflow'], ['outside tenant']));

  const candidate = await prisma.candidate.create({
    data: { tenantId, roleId: currentRoleId, fullName: 'Asha Menon', email: 'asha@example.com', phone: '555-0101' },
  });
  candidateId = candidate.id;
  await prisma.candidateAssignment.create({ data: { candidateId, userId: userAId, relation: 'owner' } });
  const rawText = 'Asha is 44, Indian, lives at 11 Lake Road. Experience\nData Engineer at Example\n- Built Python Spark Airflow data pipelines and improved reliability by 40%.';
  await prisma.candidateProfileVersion.create({
    data: {
      candidateId,
      version: 1,
      rawText,
      profileJson: JSON.stringify({ totalYears: 8, skills: ['Python', 'Spark', 'Airflow'], employment: [{ title: 'Data Engineer', company: 'Example', bullets: ['Built Python Spark Airflow data pipelines'] }], education: [], projects: [], certifications: [] }),
      fitScoreJson: JSON.stringify({ overall: 30, confidence: 0.4, components: [], missing: [], probes: [], excludedSignals: ['age', 'nationality', 'home address'] }),
    },
  });

  const noResume = await prisma.candidate.create({ data: { tenantId, roleId: currentRoleId, fullName: 'No Resume', email: 'no-resume@example.com' } });
  noResumeCandidateId = noResume.id;
  await prisma.candidateAssignment.create({ data: { candidateId: noResume.id, userId: userAId, relation: 'owner' } });

  const singleReg = await request(app).post('/api/auth/register').send({
    email: 'single-admin@questor.local', password: 'fixture-single-passphrase', name: 'Single', tenantName: 'Single Role Org',
  });
  singleRoleToken = singleReg.body.token;
  const singleTenantId = singleReg.body.user.tenantId;
  const singleRoleId = await makeApprovedRole('Only Role', singleTenantId, profile(['Python'], ['build services']));
  const singleCand = await prisma.candidate.create({ data: { tenantId: singleTenantId, roleId: singleRoleId, fullName: 'Single Candidate', email: 'single@example.com' } });
  singleRoleCandidateId = singleCand.id;
  await prisma.candidateProfileVersion.create({ data: { candidateId: singleCand.id, version: 1, rawText: 'Python services improved by 30%', profileJson: JSON.stringify({ skills: ['Python'], employment: [], education: [], projects: [], certifications: [] }), fitScoreJson: '{}' } });
});

describe('candidate profile analysis endpoint', () => {
  it('ranks scoped alternative approved roles and explains why', async () => {
    const res = await request(app).get(`/api/candidates/${candidateId}/profile-analysis`).set(auth(recruiterAToken));
    expect(res.status).toBe(200);
    expect(res.body.candidate.id).toBe(candidateId);
    expect(res.body.currentRole.id).toBe(currentRoleId);
    expect(res.body.currentFit.overall).toBeGreaterThan(0);
    expect(res.body.currentFit.components[0].rule).toMatch(/essential competencies/i);
    expect(res.body.alternativeRoles[0]).toMatchObject({ roleId: betterRoleId, title: 'Data Platform Engineer' });
    expect(res.body.alternativeRoles[0].score).toBeGreaterThan(res.body.currentFit.overall);
    expect(res.body.alternativeRoles[0].components[0].evidence.length).toBeGreaterThan(0);
    expect(res.body.alternativeRoles[0].why).toMatch(/Python|Spark|Airflow|stronger/i);
  });

  it('does not leak another tenant role in alternatives', async () => {
    const res = await request(app).get(`/api/candidates/${candidateId}/profile-analysis`).set(auth(recruiterAToken));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(otherTenantRoleId);
    expect(JSON.stringify(res.body)).not.toContain('Other Tenant Data Role');
  });

  it('does not leak an unassigned same-tenant colleague role in alternatives', async () => {
    const res = await request(app).get(`/api/candidates/${candidateId}/profile-analysis`).set(auth(recruiterAToken));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(unassignedRoleId);
    expect(JSON.stringify(res.body)).not.toContain('Secret Executive Role');
  });

  it('404s if an unassigned colleague reads the candidate directly', async () => {
    const res = await request(app).get(`/api/candidates/${candidateId}/profile-analysis`).set(auth(recruiterBToken));
    expect(res.status).toBe(404);
  });

  it('returns a plain no-resume state', async () => {
    const res = await request(app).get(`/api/candidates/${noResumeCandidateId}/profile-analysis`).set(auth(recruiterAToken));
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
    expect(res.body.currentFit).toBeNull();
    expect(res.body.alternativeRoles).toEqual([]);
    expect(res.body.betterFitMessage).toMatch(/resume/i);
  });

  it('handles a tenant with one role without alternatives', async () => {
    const res = await request(app).get(`/api/candidates/${singleRoleCandidateId}/profile-analysis`).set(auth(singleRoleToken));
    expect(res.status).toBe(200);
    expect(res.body.alternativeRoles).toEqual([]);
    expect(res.body.betterFitMessage).toMatch(/no other approved roles/i);
  });

  it('does not return raw text or excluded protected-signal values', async () => {
    const res = await request(app).get(`/api/candidates/${candidateId}/profile-analysis`).set(auth(recruiterAToken));
    expect(res.status).toBe(200);
    const payload = JSON.stringify(res.body).toLowerCase();
    expect(payload).not.toContain('indian');
    expect(payload).not.toContain('is 44');
    expect(payload).not.toContain('11 lake road');
    expect(payload).not.toContain('excludedsignals');
    expect(payload).not.toContain('rawtext');
  });

  it('hides the candidate across tenant boundaries', async () => {
    const res = await request(app).get(`/api/candidates/${candidateId}/profile-analysis`).set(auth(otherTenantToken));
    expect(res.status).toBe(404);
  });
});
