import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import { _setLlmForTests, type LlmProvider } from '../src/providers/llm/index.js';
import type { RoleSuccessProfile } from '../src/domain/types.js';
import { writeScorecardProfile } from '../src/services/scorecardVersions.js';

/**
 * HR adds, edits and removes competencies on a role's scorecard. The routes
 * are scoped like the scorecard PUT they sit beside: the role must be in the
 * caller's scope, the caller must hold role:edit_scorecard, and a competency an
 * interview has already used is retired, never deleted.
 */

const app = createApp();
// Not a credential: bcrypt-hashed locally for fixture users that never log in.
const FIXTURE_PASSPHRASE = 'not-a-real-passphrase-fixture';

let tenantId = '';
let adminToken = '';
let recruiterToken = '';
let outsiderToken = '';
let roleId = '';
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const base = () => `/api/roles/${roleId}/scorecard/competencies`;

const NEW = { name: 'Vendor Management', definition: 'Runs vendor relationships to a clear outcome.', category: 'domain', classification: 'preferred', indicators: ['Negotiates terms', 'Tracks delivery'] };

async function makeUser(role: string, email: string, tenant = tenantId): Promise<string> {
  const user = await prisma.user.create({ data: { email, name: email, passwordHash: hashPassword(FIXTURE_PASSPHRASE), role, tenantId: tenant } });
  return signToken({ userId: user.id, tenantId: tenant, role, email });
}

async function latestProfile(): Promise<RoleSuccessProfile> {
  const sc = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId }, orderBy: { version: 'desc' } });
  return JSON.parse(sc.profileJson) as RoleSuccessProfile;
}

const scoredTotal = (p: RoleSuccessProfile) => Math.round(p.competencies.filter((c) => c.classification !== 'non_scoring' && !c.retired).reduce((s, c) => s + c.weight, 0) * 100);

beforeEach(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@comp.local', password: 'fixture-admin-passphrase', name: 'Admin', tenantName: 'Competency Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;
  const role = await request(app).post('/api/roles').set(auth(adminToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  roleId = role.body.role.id;
  const recruiter = await prisma.user.create({ data: { email: 'rec@comp.local', name: 'Rec', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'recruiter', tenantId } });
  recruiterToken = signToken({ userId: recruiter.id, tenantId, role: 'recruiter', email: recruiter.email });
  await request(app).post(`/api/admin/users/${recruiter.id}/roles/${roleId}`).set(auth(adminToken)).send({});

  const other = await request(app).post('/api/auth/register').send({
    email: 'admin@other.local', password: 'fixture-admin-passphrase', name: 'Other', tenantName: 'Other Org',
  });
  outsiderToken = await makeUser('admin', 'outsider@other.local', other.body.user.tenantId);
});

afterEach(() => _setLlmForTests(null));

describe('adding a competency', () => {
  it('lets a recruiter on the role add one and answers with the new scorecard', async () => {
    const res = await request(app).post(base()).set(auth(recruiterToken)).send(NEW);

    expect(res.status).toBe(201);
  });

  it('gives the new competency an equal share and keeps the scored total at 100%', async () => {
    await request(app).post(base()).set(auth(recruiterToken)).send(NEW);

    expect(scoredTotal(await latestProfile())).toBe(100);
  });

  it('puts the competency on the scorecard by name', async () => {
    await request(app).post(base()).set(auth(recruiterToken)).send(NEW);

    expect((await latestProfile()).competencies.map((c) => c.name)).toContain('Vendor Management');
  });

  it('refuses a body that is not a competency', async () => {
    const res = await request(app).post(base()).set(auth(recruiterToken)).send({ name: '', category: 'magic' });

    expect(res.status).toBe(400);
  });

  it('refuses the same name twice', async () => {
    await request(app).post(base()).set(auth(recruiterToken)).send(NEW);
    const res = await request(app).post(base()).set(auth(recruiterToken)).send({ ...NEW, name: 'vendor management' });

    expect(res.status).toBe(409);
  });

  it('answers 404 to a user in another organisation', async () => {
    const res = await request(app).post(base()).set(auth(outsiderToken)).send(NEW);

    expect(res.status).toBe(404);
  });

  it('refuses a reviewer, who reads scorecards but does not shape them', async () => {
    const reviewer = await makeUser('reviewer', 'reviewer@comp.local');
    const res = await request(app).post(base()).set(auth(reviewer)).send(NEW);

    expect(res.status).toBe(403);
  });

  it('refuses without a token', async () => {
    const res = await request(app).post(base()).send(NEW);

    expect(res.status).toBe(401);
  });

  it('writes an audit event naming the actor and the competency', async () => {
    await request(app).post(base()).set(auth(recruiterToken)).send(NEW);
    const event = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'role.scorecard.competency.added' } });

    expect(event?.afterJson).toContain('Vendor Management');
  });

  it('saves the custom competency to the organisation library', async () => {
    await request(app).post(base()).set(auth(recruiterToken)).send(NEW);
    const entry = await prisma.orgCompetency.findFirst({ where: { tenantId, nameKey: 'vendor management' } });

    expect(entry?.definition).toBe(NEW.definition);
  });

  it('starts a new draft version when the current scorecard is approved', async () => {
    const manager = await makeUser('manager', 'manager@comp.local');
    const sc = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId } });
    await request(app).post(`/api/admin/users/${(await prisma.user.findFirstOrThrow({ where: { email: 'manager@comp.local' } })).id}/roles/${roleId}`).set(auth(adminToken)).send({});
    await request(app).post(`/api/roles/${roleId}/approve`).set(auth(manager)).send({ scorecardId: sc.id, version: sc.version });
    await request(app).post(base()).set(auth(recruiterToken)).send(NEW);
    const versions = await prisma.roleScorecardVersion.findMany({ where: { roleId }, orderBy: { version: 'asc' } });

    expect(versions.map((v) => v.status)).toEqual(['approved', 'draft']);
  });

  it('warns when more competencies are scored than the feedback letter can show', async () => {
    const res = await request(app).post(base()).set(auth(recruiterToken)).send(NEW);

    expect(res.body.warnings.join('\n')).toMatch(/feedback letter/);
  });
});

describe('editing a competency', () => {
  it('renames it', async () => {
    const first = (await latestProfile()).competencies[0];
    await request(app).patch(`${base()}/${first.id}`).set(auth(recruiterToken)).send({ name: 'Renamed Skill' });

    expect((await latestProfile()).competencies[0].name).toBe('Renamed Skill');
  });

  it('rebalances the others when a weight changes', async () => {
    const first = (await latestProfile()).competencies[0];
    await request(app).patch(`${base()}/${first.id}`).set(auth(recruiterToken)).send({ weight: 0.6 });

    expect(scoredTotal(await latestProfile())).toBe(100);
  });

  it('refuses an edit that would leave the scorecard with nothing scored', async () => {
    const profile = await latestProfile();
    for (const c of profile.competencies.slice(1)) {
      await request(app).patch(`${base()}/${c.id}`).set(auth(recruiterToken)).send({ classification: 'non_scoring' });
    }
    const res = await request(app).patch(`${base()}/${profile.competencies[0].id}`).set(auth(recruiterToken)).send({ classification: 'non_scoring' });

    expect(res.status).toBe(400);
  });

  it('refuses to store a profile whose scored weights do not total 100%, whichever route computed it', async () => {
    const latest = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId }, orderBy: { version: 'desc' } });
    const profile = await latestProfile();
    const overWeighted = { ...profile, competencies: profile.competencies.map((c) => ({ ...c, weight: 5 })) };

    await expect(writeScorecardProfile(roleId, latest, overWeighted)).rejects.toMatchObject({ status: 400, code: 'scorecard_invalid' });
  });

  it('answers 404 for a competency id that is not on the scorecard', async () => {
    const res = await request(app).patch(`${base()}/nope1234`).set(auth(recruiterToken)).send({ name: 'X' });

    expect(res.status).toBe(404);
  });

  it('records the name before and after in the audit trail', async () => {
    const first = (await latestProfile()).competencies[0];
    await request(app).patch(`${base()}/${first.id}`).set(auth(recruiterToken)).send({ name: 'Renamed Skill' });
    const event = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'role.scorecard.competency.updated' } });

    expect([event?.beforeJson.includes(first.name), event?.afterJson.includes('Renamed Skill')]).toEqual([true, true]);
  });
});

describe('removing a competency', () => {
  it('deletes a competency no interview has used', async () => {
    const first = (await latestProfile()).competencies[0];
    const res = await request(app).delete(`${base()}/${first.id}`).set(auth(recruiterToken));

    expect(res.body.retired).toBe(false);
  });

  it('leaves the scored weights totalling 100% after the delete', async () => {
    const first = (await latestProfile()).competencies[0];
    await request(app).delete(`${base()}/${first.id}`).set(auth(recruiterToken));

    expect(scoredTotal(await latestProfile())).toBe(100);
  });

  it('retires, rather than deletes, a competency a transcript refers to', async () => {
    const first = (await latestProfile()).competencies[0];
    await sessionWithTurnOn(first.id);
    const res = await request(app).delete(`${base()}/${first.id}`).set(auth(recruiterToken));

    expect(res.body.retired).toBe(true);
  });

  it('keeps a retired competency on the scorecard at zero weight', async () => {
    const first = (await latestProfile()).competencies[0];
    await sessionWithTurnOn(first.id);
    await request(app).delete(`${base()}/${first.id}`).set(auth(recruiterToken));
    const kept = (await latestProfile()).competencies.find((c) => c.id === first.id);

    expect(kept).toMatchObject({ retired: true, weight: 0 });
  });

  it('tells the role page which competencies have history', async () => {
    const first = (await latestProfile()).competencies[0];
    await sessionWithTurnOn(first.id);
    const res = await request(app).get(`/api/roles/${roleId}`).set(auth(recruiterToken));

    expect(res.body.competencyHistory).toEqual([first.id]);
  });

  it('answers 404 to a user in another organisation', async () => {
    const first = (await latestProfile()).competencies[0];
    const res = await request(app).delete(`${base()}/${first.id}`).set(auth(outsiderToken));

    expect(res.status).toBe(404);
  });
});

describe('drafting a competency', () => {
  it('drafts from the JD without a model and says so', async () => {
    const res = await request(app).post(`${base()}/draft`).set(auth(recruiterToken)).send({ name: 'Stakeholder Management' });

    expect([res.status, res.body.source, res.body.draft.indicators.length >= 3]).toEqual([200, 'heuristic', true]);
  });

  it('uses the model draft when a provider answers', async () => {
    _setLlmForTests(fakeProvider(JSON.stringify({
      definition: 'Keeps vendors delivering on time and on budget.',
      indicators: ['Sets terms', 'Tracks delivery', 'Escalates early'],
      category: 'domain',
      suggestedClassification: 'preferred',
    })));
    const res = await request(app).post(`${base()}/draft`).set(auth(recruiterToken)).send({ name: 'Vendor Management' });

    expect([res.body.source, res.body.draft.definition]).toEqual(['model', 'Keeps vendors delivering on time and on budget.']);
  });

  it('falls back to the heuristic draft when the model answers nonsense', async () => {
    _setLlmForTests(fakeProvider('{"definition": "x"}'));
    const res = await request(app).post(`${base()}/draft`).set(auth(recruiterToken)).send({ name: 'Vendor Management' });

    expect(res.body.source).toBe('heuristic');
  });

  it('persists nothing', async () => {
    const before = (await latestProfile()).competencies.length;
    await request(app).post(`${base()}/draft`).set(auth(recruiterToken)).send({ name: 'Vendor Management' });

    expect((await latestProfile()).competencies.length).toBe(before);
  });
});

describe('the organisation library', () => {
  it('lists what this organisation has saved, and nothing from another', async () => {
    await request(app).post(base()).set(auth(recruiterToken)).send(NEW);
    await prisma.orgCompetency.create({ data: { tenantId: (await prisma.user.findFirstOrThrow({ where: { email: 'outsider@other.local' } })).tenantId, name: 'Secret Skill', nameKey: 'secret skill', category: 'domain' } });
    const res = await request(app).get(`${base()}/library`).set(auth(recruiterToken));

    expect(res.body.competencies.map((c: { name: string }) => c.name)).toEqual(['Vendor Management']);
  });

  it('adds from the library by copying its definition', async () => {
    await prisma.orgCompetency.create({ data: { tenantId, name: 'Vendor Management', nameKey: 'vendor management', category: 'domain', definition: 'From the library.', indicatorsJson: JSON.stringify(['Tracks delivery']) } });
    const entry = await prisma.orgCompetency.findFirstOrThrow({ where: { tenantId } });
    await request(app).post(base()).set(auth(recruiterToken)).send({ libraryId: entry.id, classification: 'preferred' });

    expect((await latestProfile()).competencies.find((c) => c.name === 'Vendor Management')?.definition).toBe('From the library.');
  });
});

/** A finished interview on this role with one candidate turn tagged to the competency. */
async function sessionWithTurnOn(competencyId: string) {
  const sc = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId } });
  const candidate = await prisma.candidate.create({ data: { tenantId, roleId, fullName: 'C', email: 'c@comp.local' } });
  const session = await prisma.interviewSession.create({ data: { tenantId, candidateId: candidate.id, roleId, scorecardId: sc.id, state: 'COMPLETED' } });
  await prisma.turn.create({ data: { sessionId: session.id, index: 0, speaker: 'candidate', text: 'An answer', competencyId } });
}

function fakeProvider(text: string): LlmProvider {
  return {
    name: 'fake',
    enabled: true,
    generate: async () => ({ text, model: 'fake', inputTokens: 1, outputTokens: 1, latencyMs: 1 }),
  };
}
