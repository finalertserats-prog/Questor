import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { prisma } from '../../src/db.js';
import type { InterviewPlan, RoleSuccessProfile } from '../../src/domain/types.js';
import { buildInterviewPlan } from '../../src/engines/interviewPlanner.js';
import { attachLibrary } from '../../src/library/planning.js';
import { CALLBACK_BLOCK_ID } from '../../src/library/planLadders.js';
import { seededRandom } from '../../src/library/sample.js';
import { wipe } from '../../src/seed/demoData.js';
import { bearer, entry, seedLibraryWorld, type LibraryWorld } from './libraryFixtures.js';

/**
 * The planner asking the library for ladders. With LIBRARY_ENABLED off, or the
 * organisation's switch off, the plan is exactly what it was; anything that
 * goes wrong leaves every block on the built-in bank without failing.
 */

let world: LibraryWorld;
let profile: RoleSuccessProfile;
let candidateId: string;
let scorecardId: string;

beforeEach(async () => {
  // Interviews made here hold candidates, plans and audit rows the library fixture does not clear.
  await prisma.libraryUsage.deleteMany();
  await wipe();
  world = await seedLibraryWorld();
  config.library.enabled = true;
  const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: world.roleId } });
  scorecardId = scorecard.id;
  profile = JSON.parse(scorecard.profileJson) as RoleSuccessProfile;
  const candidate = await prisma.candidate.create({ data: { tenantId: world.admin.tenantId, roleId: world.roleId, fullName: 'Asha Rao', email: `asha-${Date.now()}@example.com` } });
  candidateId = candidate.id;
});

afterEach(() => {
  config.library.enabled = false;
});

async function setPolicy(policy: Record<string, unknown>) {
  await prisma.tenant.update({ where: { id: world.admin.tenantId }, data: { policyJson: JSON.stringify(policy) } });
}

async function fillPools() {
  for (const key of world.competencyKeys) {
    for (const [i, form] of ['star', 'opinion', 'tradeoff'].entries()) await entry(world, { competencyKey: key, form, difficultyTag: i + 1 });
  }
}

function basePlan(): InterviewPlan {
  return buildInterviewPlan({ role: profile, durationMinutes: 45 });
}

function ctx(overrides: Partial<Parameters<typeof attachLibrary>[1]> = {}): Parameters<typeof attachLibrary>[1] {
  return { tenantId: world.admin.tenantId, roleId: world.roleId, candidateId, scorecardId, competencies: profile.competencies, rng: seededRandom(4), ...overrides };
}

describe('with the library off', () => {
  it('returns the very same plan when LIBRARY_ENABLED is false', async () => {
    config.library.enabled = false;
    await setPolicy({ questionLibrary: 'on' });
    const plan = basePlan();
    expect(await attachLibrary(plan, ctx())).toBe(plan);
  });

  it('returns the very same plan when the organisation has not switched it on', async () => {
    await fillPools();
    const plan = basePlan();
    expect(await attachLibrary(plan, ctx())).toBe(plan);
  });

  it('returns the very same plan when the organisation switched it off', async () => {
    await setPolicy({ questionLibrary: 'off' });
    const plan = basePlan();
    expect(await attachLibrary(plan, ctx())).toBe(plan);
  });

  it('stores a plan with no library in it when an interview is created with the flag off', async () => {
    config.library.enabled = false;
    await setPolicy({ questionLibrary: 'on' });
    await fillPools();
    const res = await request(createApp()).post('/api/interviews').set('Authorization', bearer(world.admin.token)).send({ candidateId });
    expect(res.status).toBe(201);
    const stored = await prisma.interviewPlanVersion.findUniqueOrThrow({ where: { sessionId: res.body.session.id } });
    expect(stored.planJson).not.toMatch(/library|__callback__/);
  });
});

describe('with the library on for the organisation', () => {
  beforeEach(async () => {
    await setPolicy({ questionLibrary: 'on' });
  });

  it('stores a ladder with snapshots on every block the library can serve', async () => {
    await fillPools();
    const plan = await attachLibrary(basePlan(), ctx());
    const ladders = plan.blocks.filter((b) => b.library?.source === 'library').map((b) => b.library?.ladder?.length);
    expect(ladders).toEqual([3, 3]);
  });

  it('stores the rubric version the anchors were chosen against', async () => {
    await fillPools();
    expect((await attachLibrary(basePlan(), ctx())).library?.rubricVersion).toBe(scorecardId);
  });

  it('stores the anchors in the snapshot', async () => {
    await fillPools();
    const plan = await attachLibrary(basePlan(), ctx());
    expect(plan.blocks.find((b) => b.library?.source === 'library')?.library?.ladder?.[0].anchors.length).toBeGreaterThan(0);
  });

  it('adds the callback turn', async () => {
    await fillPools();
    expect((await attachLibrary(basePlan(), ctx())).blocks.some((b) => b.competencyId === CALLBACK_BLOCK_ID)).toBe(true);
  });

  it('falls back to the built-in bank for a thin pool', async () => {
    const plan = await attachLibrary(basePlan(), ctx());
    expect(plan.blocks.filter((b) => b.library).every((b) => b.library?.source === 'builtin' && b.library.reason === 'no_ladder')).toBe(true);
  });

  it('falls back to the built-in bank when select errors, without failing', async () => {
    await fillPools();
    const plan = await attachLibrary(basePlan(), ctx({ select: async () => { throw new Error('boom'); } }));
    expect(plan.library?.unavailable).toBe('select_failed');
  });

  it('keeps every block built-in when select errors', async () => {
    const plan = await attachLibrary(basePlan(), ctx({ select: async () => { throw new Error('boom'); } }));
    expect(plan.blocks.filter((b) => b.library).every((b) => b.library?.source === 'builtin')).toBe(true);
  });

  it('keeps the planner blocks when the role is not in the catalog', async () => {
    await prisma.role.update({ where: { id: world.roleId }, data: { catalogRoleId: null } });
    const plan = await attachLibrary(basePlan(), ctx());
    expect(plan.library?.unavailable).toBe('role_not_in_catalog');
  });

  it('passes the no-repeat window the organisation chose', async () => {
    await setPolicy({ questionLibrary: 'on', questionLibraryWindowDays: 45 });
    let seen = 0;
    await attachLibrary(basePlan(), ctx({ select: async (req) => { seen = req.windowDays; return {}; } }));
    expect(seen).toBe(45);
  });

  it('defaults the no-repeat window to 30 days', async () => {
    let seen = 0;
    await attachLibrary(basePlan(), ctx({ select: async (req) => { seen = req.windowDays; return {}; } }));
    expect(seen).toBe(30);
  });

  it('asks for live entries only outside the trial', async () => {
    let probational: boolean | undefined;
    await attachLibrary(basePlan(), ctx({ select: async (req) => { probational = req.includeProbational; return {}; } }));
    expect(probational).toBe(false);
  });

  it('never offers a candidate an entry from an earlier plan of theirs', async () => {
    await fillPools();
    const first = await attachLibrary(basePlan(), ctx());
    const session = await prisma.interviewSession.create({ data: { tenantId: world.admin.tenantId, candidateId, roleId: world.roleId, scorecardId, state: 'INCOMPLETE' } });
    await prisma.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(first) } });
    let excluded: readonly string[] = [];
    await attachLibrary(basePlan(), ctx({ select: async (req) => { excluded = req.excludeEntryIds ?? []; return {}; } }));
    const offered = first.blocks.flatMap((b) => b.library?.ladder ?? []).map((r) => r.entryId);
    expect([...excluded].sort()).toEqual([...offered].sort());
  });

  it('plans the library into an interview created through the API', async () => {
    await fillPools();
    const res = await request(createApp()).post('/api/interviews').set('Authorization', bearer(world.admin.token)).send({ candidateId });
    const stored = JSON.parse((await prisma.interviewPlanVersion.findUniqueOrThrow({ where: { sessionId: res.body.session.id } })).planJson) as InterviewPlan;
    expect(stored.library?.mode).toBe('on');
  });
});

describe('in trial mode', () => {
  it('asks for probational entries too', async () => {
    await setPolicy({ questionLibrary: 'trial' });
    let probational: boolean | undefined;
    await attachLibrary(basePlan(), ctx({ select: async (req) => { probational = req.includeProbational; return {}; } }));
    expect(probational).toBe(true);
  });

  it('splits the eligible blocks between the library and the built-in bank', async () => {
    await setPolicy({ questionLibrary: 'trial' });
    await fillPools();
    const plan = await attachLibrary(basePlan(), ctx());
    expect(plan.blocks.filter((b) => b.library?.trial).map((b) => b.library?.source).sort()).toEqual(['builtin', 'library']);
  });

  it('is the default for the demo sandbox', async () => {
    await prisma.tenant.update({ where: { id: world.admin.tenantId }, data: { isDemo: true } });
    await fillPools();
    expect((await attachLibrary(basePlan(), ctx())).library?.mode).toBe('trial');
  });
});

describe('what the hiring team sees', () => {
  async function interviewWithLibrary() {
    await setPolicy({ questionLibrary: 'on' });
    await fillPools();
    const res = await request(createApp()).post('/api/interviews').set('Authorization', bearer(world.admin.token)).send({ candidateId });
    return res;
  }

  it('does not return the library questions when an interview is created', async () => {
    const res = await interviewWithLibrary();
    expect(JSON.stringify(res.body.plan)).not.toContain('Seeded');
  });

  it('does not show the library questions on the interview page', async () => {
    const created = await interviewWithLibrary();
    const res = await request(createApp()).get(`/api/interviews/${created.body.session.id}`).set('Authorization', bearer(world.admin.token));
    expect(JSON.stringify(res.body.plan)).not.toContain('Seeded');
  });

  it('lists the questions asked on the assessment of a library-planned interview', async () => {
    const created = await interviewWithLibrary();
    const sessionId = created.body.session.id as string;
    await prisma.turn.create({ data: { sessionId, index: 0, speaker: 'agent', text: 'Walk me through a settlement failure you owned?', competencyId: 'c1', metaJson: JSON.stringify({ kind: 'question', libraryEntryId: 'x', rungMove: 'start' }) } });
    const assessment = await prisma.assessmentVersion.create({ data: { sessionId, scorecardId, recommendation: 'CONSIDER', resultJson: JSON.stringify({ recommendation: 'CONSIDER', overallScore: 68, competencies: [] }) } });
    const res = await request(createApp()).get(`/api/assessments/${assessment.id}`).set('Authorization', bearer(world.admin.token));
    expect(res.body.questionsAsked).toEqual([{ competencyId: 'c1', competencyName: 'Incident Ownership', source: 'library', question: 'Walk me through a settlement failure you owned?', rungMove: 'start' }]);
  });

  it('adds no questions list to the assessment of an interview planned without the library', async () => {
    config.library.enabled = false;
    const created = await request(createApp()).post('/api/interviews').set('Authorization', bearer(world.admin.token)).send({ candidateId });
    const assessment = await prisma.assessmentVersion.create({ data: { sessionId: created.body.session.id, scorecardId, recommendation: 'CONSIDER', resultJson: JSON.stringify({ recommendation: 'CONSIDER', overallScore: 68, competencies: [] }) } });
    const res = await request(createApp()).get(`/api/assessments/${assessment.id}`).set('Authorization', bearer(world.admin.token));
    expect(res.body).not.toHaveProperty('questionsAsked');
  });
});

describe('the Hiring policy switch', () => {
  const put = (policy: Record<string, unknown>) => request(createApp()).put('/api/admin/policy').set('Authorization', bearer(world.admin.token)).send({ policy });

  it('saves the organisation choice', async () => {
    await put({ questionLibrary: 'trial', questionLibraryTrialPercent: 50, questionLibraryWindowDays: 30 });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: world.admin.tenantId } });
    expect(JSON.parse(tenant.policyJson)).toMatchObject({ questionLibrary: 'trial', questionLibraryTrialPercent: 50, questionLibraryWindowDays: 30 });
  });

  it('refuses a mode that does not exist', async () => {
    expect((await put({ questionLibrary: 'always' })).status).toBe(400);
  });

  it('refuses a window longer than a year', async () => {
    expect((await put({ questionLibraryWindowDays: 400 })).status).toBe(400);
  });
});

describe('the trial report route', () => {
  it('is the platform owner alone', async () => {
    const res = await request(createApp()).get('/api/library/admin/trial-report').set('Authorization', bearer(world.admin.token));
    expect(res.status).toBe(403);
  });

  it('reports the paired comparison to the owner', async () => {
    await prisma.libraryUsage.createMany({ data: [
      { interviewSessionId: 'p1', tenantId: world.admin.tenantId, competencyId: 'c1', blockSource: 'library', trial: true, evidenceYield: 0.7, blockKey: 'c1#a' },
      { interviewSessionId: 'p1', tenantId: world.admin.tenantId, competencyId: 'c2', blockSource: 'builtin', trial: true, evidenceYield: 0.5, blockKey: 'c2#builtin' },
    ] });
    const res = await request(createApp()).get('/api/library/admin/trial-report').set('Authorization', bearer(world.operator.token));
    expect(res.body.report).toMatchObject({ interviews: 1, pairedYieldDifference: 0.2 });
  });
});
