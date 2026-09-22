import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe, DEMO_JD } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import { assignCandidate, assignRole } from '../src/services/access.js';

/**
 * The role page's candidate comparison: the table, the skills grid, the
 * side-by-side and the shortlist behind them.
 *
 * Hiring is comparative, so these endpoints put a whole pipeline on one screen.
 * That makes them the widest read of candidate data in the product, which is
 * why object scope, tenant isolation and the blind-review policy are asserted
 * here on every one of them rather than on the table alone.
 */

const app = createApp();

// Not a credential: hashed locally for fixture users that never sign in. Only
// `signToken` output authenticates them.
const FIXTURE_PASSPHRASE = 'not-a-real-passphrase-fixture';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A fresh bearer for the demo admin; the token the seed returns is not re-signed per test. */
function demoToken(ids: { userId: string; tenantId: string; email: string }): string {
  return signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email });
}

interface ScoredCompetency {
  id: string; name: string; level: number | null; requiredLevel: number; confidence: number;
  notEnoughEvidence: boolean; evidence: { turnId: string; quote: string; startMs: number; endMs: number }[];
  rationale: string; rubricVersion: string;
}

function competencyScore(over: Partial<ScoredCompetency> & { id: string }): ScoredCompetency {
  return {
    name: over.id, level: 3, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false,
    evidence: [{ turnId: 't1', quote: `Evidence for ${over.id}`, startMs: 0, endMs: 1000 }],
    rationale: `Because of ${over.id}`, rubricVersion: 'v1',
    ...over,
  };
}

function result(over: { overallScore?: number | null; competencies?: ScoredCompetency[]; recommendation?: string }) {
  return {
    assessmentVersion: 'v1', roleScorecardVersion: 'v1',
    recommendation: over.recommendation ?? 'CONSIDER', confidence: 0.8, evidenceCoverage: 0.7,
    overallScore: over.overallScore ?? 70, competencies: over.competencies ?? [],
    strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'Summary.',
  };
}

/** A second applicant on the demo role, with an interview and an assessment. */
async function addApplicant(o: {
  ids: Awaited<ReturnType<typeof createDemoData>>;
  name: string;
  recommendation: string;
  overallScore: number | null;
  competencies?: ScoredCompetency[];
  scorecardId?: string;
  durationMinutes?: number;
}) {
  const candidate = await prisma.candidate.create({
    data: {
      tenantId: o.ids.tenantId, roleId: o.ids.roleId, fullName: o.name,
      email: `${o.name.replace(/\s+/g, '.').toLowerCase()}@example.com`,
      emailNormalized: `${o.name.replace(/\s+/g, '.').toLowerCase()}@example.com`,
    },
  });
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: o.ids.tenantId, candidateId: candidate.id, roleId: o.ids.roleId,
      scorecardId: o.scorecardId ?? o.ids.scorecardId, state: 'REVIEW_READY',
      durationMinutes: o.durationMinutes ?? 45, completedAt: new Date(),
    },
  });
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: session.id, scorecardId: o.scorecardId ?? o.ids.scorecardId,
      recommendation: o.recommendation, confidence: 0.8, evidenceCoverage: 0.7,
      resultJson: JSON.stringify(result({ overallScore: o.overallScore, competencies: o.competencies, recommendation: o.recommendation })),
    },
  });
  return { candidateId: candidate.id, sessionId: session.id, assessmentId: assessment.id };
}

/** The competency ids the demo role's approved scorecard actually carries. */
async function roleCompetencyIds(roleId: string): Promise<string[]> {
  const scorecard = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId }, orderBy: { version: 'desc' } });
  const profile = JSON.parse(scorecard.profileJson) as { competencies: { id: string; classification: string }[] };
  return profile.competencies.filter((c) => c.classification !== 'non_scoring').map((c) => c.id);
}

async function requireBlind(tenantId: string, value: boolean) {
  await prisma.tenant.update({ where: { id: tenantId }, data: { policyJson: JSON.stringify({ requireBlindReview: value }) } });
}

beforeEach(async () => {
  await prisma.candidateShortlist.deleteMany();
  await wipe();
});

describe('GET /api/roles/:id/candidates', () => {
  it('lists the role applicants the caller may see', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.map((c: { fullName: string }) => c.fullName).sort()).toEqual(['Ada Lovelace', 'Priya Sharma']);
  });

  it('counts every applicant, not only the page', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.meta.total).toBe(2);
  });

  it('orders by verdict, strongest first', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Weak One', recommendation: 'DO_NOT_PROGRESS', overallScore: 30 });
    await addApplicant({ ids, name: 'Strong One', recommendation: 'PROCEED', overallScore: 90 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=verdict&dir=desc`).set(auth(demoToken(ids)));
    expect(res.body.candidates[0].fullName).toBe('Strong One');
  });

  it('orders by score across the whole pipeline, not only the page', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Low', recommendation: 'CONSIDER', overallScore: 41 });
    await addApplicant({ ids, name: 'High', recommendation: 'CONSIDER', overallScore: 93 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=score&dir=desc&pageSize=25`).set(auth(demoToken(ids)));
    expect(res.body.candidates[0].fullName).toBe('High');
  });

  it('orders by name when asked', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Aaron First', recommendation: 'CONSIDER', overallScore: 10 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=name&dir=asc`).set(auth(demoToken(ids)));
    expect(res.body.candidates[0].fullName).toBe('Aaron First');
  });

  it('reports the sort it applied', async () => {
    const ids = await createDemoData();
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=stage&dir=asc`).set(auth(demoToken(ids)));
    expect(res.body.sort).toEqual({ key: 'stage', dir: 'asc' });
  });

  it('refuses a sort key it does not offer', async () => {
    const ids = await createDemoData();
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=salary`).set(auth(demoToken(ids)));
    expect(res.status).toBe(400);
  });

  it('pages the rows it returns', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?pageSize=25&page=2`).set(auth(demoToken(ids)));
    expect(res.body.candidates).toEqual([]);
  });

  it('carries the overall score of the interview', async () => {
    const ids = await createDemoData();
    const { candidateId } = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === candidateId).overallScore).toBe(91);
  });

  it('searches by name', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?q=lovelace`).set(auth(demoToken(ids)));
    expect(res.body.candidates.map((c: { fullName: string }) => c.fullName)).toEqual(['Ada Lovelace']);
  });
});

describe('the verdict shown on the table', () => {
  it("reports the reviewer's verdict once someone has recorded one", async () => {
    const ids = await createDemoData();
    const added = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'CONSIDER', overallScore: 60 });
    await prisma.humanReview.create({
      data: {
        assessmentId: added.assessmentId, reviewerId: ids.userId, status: 'COMPLETED', disposition: 'PROCEED',
        activeForAssessmentId: added.assessmentId, completedAt: new Date(), reason: 'Strong evidence.', overridesJson: '[]',
      },
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === added.candidateId).humanRecommendation).toBe('PROCEED');
  });

  it('never prints the stored pipeline enum', async () => {
    const ids = await createDemoData();
    await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(JSON.stringify(res.body)).not.toContain('APPROVED');
  });
});

describe('the blind-review policy on the comparison', () => {
  it("withholds a candidate's AI recommendation from a reviewer who owes their own verdict", async () => {
    const ids = await createDemoData();
    await requireBlind(ids.tenantId, true);
    const added = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    const row = res.body.candidates.find((c: { id: string }) => c.id === added.candidateId);
    expect({ pending: row.blindReviewPending, rec: row.recommendation }).toEqual({ pending: true, rec: undefined });
  });

  it('withholds the score with the recommendation', async () => {
    const ids = await createDemoData();
    await requireBlind(ids.tenantId, true);
    const added = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === added.candidateId).overallScore).toBeUndefined();
  });

  it("withholds a colleague's verdict too, since it would anchor just as hard", async () => {
    const ids = await createDemoData();
    await requireBlind(ids.tenantId, true);
    const added = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'CONSIDER', overallScore: 60 });
    await prisma.humanReview.create({
      data: {
        assessmentId: added.assessmentId, reviewerId: ids.userId, status: 'COMPLETED', disposition: 'PROCEED',
        activeForAssessmentId: added.assessmentId, completedAt: new Date(), reason: 'Strong.', overridesJson: '[]',
      },
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === added.candidateId).humanRecommendation).toBeUndefined();
  });

  it('leaves the withheld candidate out of the grid cells', async () => {
    const ids = await createDemoData();
    await requireBlind(ids.tenantId, true);
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const added = await addApplicant({
      ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91,
      competencies: competencyIds.map((id) => competencyScore({ id, level: 5 })),
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(demoToken(ids)));
    expect(res.body.rows.find((r: { candidateId: string }) => r.candidateId === added.candidateId).cells).toEqual({});
  });

  it('opens once that reviewer has recorded their own blind verdict', async () => {
    const ids = await createDemoData();
    await requireBlind(ids.tenantId, true);
    const added = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    await request(app).post(`/api/assessments/${added.assessmentId}/blind-verdict`).set(auth(demoToken(ids)))
      .send({ verdict: 'CONSIDER', reason: 'My own read of the evidence.' });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === added.candidateId).recommendation).toBe('PROCEED');
  });

  it('shows everything to an organisation that does not require blind review', async () => {
    const ids = await createDemoData();
    const added = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === added.candidateId).recommendation).toBe('PROCEED');
  });
});

describe('GET /api/roles/:id/candidates/grid', () => {
  it('names the role competencies as its columns', async () => {
    const ids = await createDemoData();
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(demoToken(ids)));
    expect(res.body.competencies.map((c: { id: string }) => c.id)).toEqual(competencyIds);
  });

  it('reads a graded competency as its level', async () => {
    const ids = await createDemoData();
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const added = await addApplicant({
      ids, name: 'Ada Lovelace', recommendation: 'PROCEED', overallScore: 91,
      competencies: [competencyScore({ id: competencyIds[0], level: 4 })],
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(demoToken(ids)));
    const row = res.body.rows.find((r: { candidateId: string }) => r.candidateId === added.candidateId);
    expect(row.cells[competencyIds[0]]).toEqual({ kind: 'level', level: 4 });
  });

  it('says there is no evidence rather than showing a zero', async () => {
    const ids = await createDemoData();
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const added = await addApplicant({
      ids, name: 'Ada Lovelace', recommendation: 'CONSIDER', overallScore: 50,
      competencies: [competencyScore({ id: competencyIds[0], level: null, notEnoughEvidence: true })],
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(demoToken(ids)));
    const row = res.body.rows.find((r: { candidateId: string }) => r.candidateId === added.candidateId);
    expect(row.cells[competencyIds[0]]).toEqual({ kind: 'no_evidence' });
  });

  it('says a competency was never put to a candidate the assessment has no row for', async () => {
    const ids = await createDemoData();
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const added = await addApplicant({
      ids, name: 'Ada Lovelace', recommendation: 'CONSIDER', overallScore: 50,
      competencies: [competencyScore({ id: competencyIds[0], level: 3 })],
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(demoToken(ids)));
    const row = res.body.rows.find((r: { candidateId: string }) => r.candidateId === added.candidateId);
    expect(row.cells[competencyIds[1]]).toEqual({ kind: 'not_assessed' });
  });

  it("shows the reviewer's level where they overrode the AI", async () => {
    const ids = await createDemoData();
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const added = await addApplicant({
      ids, name: 'Ada Lovelace', recommendation: 'CONSIDER', overallScore: 50,
      competencies: [competencyScore({ id: competencyIds[0], level: 2 })],
    });
    await prisma.humanReview.create({
      data: {
        assessmentId: added.assessmentId, reviewerId: ids.userId, status: 'COMPLETED', disposition: 'PROCEED',
        activeForAssessmentId: added.assessmentId, completedAt: new Date(), reason: 'Re-read the transcript.',
        overridesJson: JSON.stringify([{ competencyId: competencyIds[0], from: 2, to: 5, reason: 'Clear worked example.' }]),
      },
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(demoToken(ids)));
    const row = res.body.rows.find((r: { candidateId: string }) => r.candidateId === added.candidateId);
    expect(row.cells[competencyIds[0]]).toEqual({ kind: 'level', level: 5 });
  });

  it('says whose levels a row is showing', async () => {
    const ids = await createDemoData();
    const added = await addApplicant({ ids, name: 'Ada Lovelace', recommendation: 'CONSIDER', overallScore: 50 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(demoToken(ids)));
    expect(res.body.rows.find((r: { candidateId: string }) => r.candidateId === added.candidateId).levelSource).toBe('ai');
  });
});

describe('scores that were not produced the same way', () => {
  it('marks the candidate assessed against a different scorecard version', async () => {
    const ids = await createDemoData();
    const older = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: ids.roleId } });
    const newer = await prisma.roleScorecardVersion.create({
      data: { roleId: ids.roleId, version: 2, status: 'approved', profileJson: older.profileJson, approvedAt: new Date() },
    });
    const old = await addApplicant({ ids, name: 'Older Rubric', recommendation: 'PROCEED', overallScore: 80, scorecardId: older.id });
    await addApplicant({ ids, name: 'Newer Rubric', recommendation: 'PROCEED', overallScore: 80, scorecardId: newer.id });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=name&dir=asc`).set(auth(demoToken(ids)));
    const row = res.body.candidates.find((c: { id: string }) => c.id === old.candidateId);
    expect(row.comparability.map((n: { kind: string }) => n.kind)).toContain('scorecard_version');
  });

  it('marks a markedly shorter interview as a shallower one', async () => {
    const ids = await createDemoData();
    const short = await addApplicant({ ids, name: 'Short Interview', recommendation: 'PROCEED', overallScore: 80, durationMinutes: 20 });
    await addApplicant({ ids, name: 'Long Interview', recommendation: 'PROCEED', overallScore: 80, durationMinutes: 60 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=name&dir=asc`).set(auth(demoToken(ids)));
    const row = res.body.candidates.find((c: { id: string }) => c.id === short.candidateId);
    expect(row.comparability.map((n: { kind: string }) => n.kind)).toContain('interview_depth');
  });

  it('says nothing when everyone was assessed the same way', async () => {
    const ids = await createDemoData();
    const a = await addApplicant({ ids, name: 'One', recommendation: 'PROCEED', overallScore: 80 });
    await addApplicant({ ids, name: 'Two', recommendation: 'CONSIDER', overallScore: 60 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates?sort=name&dir=asc`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === a.candidateId).comparability).toEqual([]);
  });
});

describe('the shortlist', () => {
  it('starts empty', async () => {
    const ids = await createDemoData();
    const res = await request(app).get(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids)));
    expect(res.body.candidateIds).toEqual([]);
  });

  it('keeps a candidate that was ticked', async () => {
    const ids = await createDemoData();
    await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: ids.candidateId });
    const res = await request(app).get(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids)));
    expect(res.body.candidateIds).toEqual([ids.candidateId]);
  });

  it('records one tick however many times the same one arrives', async () => {
    const ids = await createDemoData();
    await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: ids.candidateId });
    const res = await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: ids.candidateId });
    expect(res.body.candidateIds).toEqual([ids.candidateId]);
  });

  it('removes a tick', async () => {
    const ids = await createDemoData();
    await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: ids.candidateId });
    const res = await request(app).delete(`/api/roles/${ids.roleId}/shortlist/${ids.candidateId}`).set(auth(demoToken(ids)));
    expect(res.body.candidateIds).toEqual([]);
  });

  it('refuses a fifth candidate, because four is what reads side by side', async () => {
    const ids = await createDemoData();
    const extra = [];
    for (const name of ['A One', 'B Two', 'C Three', 'D Four']) {
      extra.push(await addApplicant({ ids, name, recommendation: 'CONSIDER', overallScore: 50 }));
    }
    for (const added of extra) {
      await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: added.candidateId });
    }
    const res = await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: ids.candidateId });
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'shortlist_full' });
  });

  it('refuses a candidate who is not on this role', async () => {
    const ids = await createDemoData();
    const other = await prisma.role.create({
      data: { tenantId: ids.tenantId, title: 'Other Role', sourceType: 'paste', sourceText: DEMO_JD, status: 'approved', createdById: ids.userId },
    });
    await assignRole(other.id, ids.userId, 'owner');
    const stranger = await prisma.candidate.create({
      data: { tenantId: ids.tenantId, roleId: other.id, fullName: 'Other Person', email: 'other@example.com', emailNormalized: 'other@example.com' },
    });
    const res = await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: stranger.id });
    expect(res.status).toBe(404);
  });

  it('is one reviewer\'s own: a colleague\'s ticks are not theirs', async () => {
    const ids = await createDemoData();
    const colleague = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'colleague@example.com', name: 'Colleague', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'manager' },
    });
    await assignRole(ids.roleId, colleague.id, 'owner');
    await assignCandidate(ids.candidateId, colleague.id, 'owner');
    const colleagueToken = signToken({ userId: colleague.id, tenantId: ids.tenantId, role: 'manager', email: 'colleague@example.com' });
    await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: ids.candidateId });
    const res = await request(app).get(`/api/roles/${ids.roleId}/shortlist`).set(auth(colleagueToken));
    expect(res.body.candidateIds).toEqual([]);
  });

  it('tells the table which rows this viewer has ticked', async () => {
    const ids = await createDemoData();
    await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(demoToken(ids))).send({ candidateId: ids.candidateId });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === ids.candidateId).shortlisted).toBe(true);
  });
});

describe('GET /api/roles/:id/candidates/comparison', () => {
  it('reads two shortlisted candidates against each other', async () => {
    const ids = await createDemoData();
    const one = await addApplicant({ ids, name: 'One Person', recommendation: 'PROCEED', overallScore: 80 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${one.candidateId},${ids.candidateId}`).set(auth(demoToken(ids)));
    expect(res.body.candidates.map((c: { id: string }) => c.id).sort()).toEqual([one.candidateId, ids.candidateId].sort());
  });

  it('refuses a comparison of one', async () => {
    const ids = await createDemoData();
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${ids.candidateId}`).set(auth(demoToken(ids)));
    expect(res.status).toBe(400);
  });

  it('refuses more than four', async () => {
    const ids = await createDemoData();
    const extra = [];
    for (const name of ['A One', 'B Two', 'C Three', 'D Four']) {
      extra.push(await addApplicant({ ids, name, recommendation: 'CONSIDER', overallScore: 50 }));
    }
    const all = [...extra.map((e) => e.candidateId), ids.candidateId].join(',');
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${all}`).set(auth(demoToken(ids)));
    expect(res.status).toBe(400);
  });

  it('carries the top evidence quotes for each competency', async () => {
    const ids = await createDemoData();
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const one = await addApplicant({
      ids, name: 'One Person', recommendation: 'PROCEED', overallScore: 80,
      competencies: [competencyScore({ id: competencyIds[0], level: 4 })],
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${one.candidateId},${ids.candidateId}`).set(auth(demoToken(ids)));
    const compared = res.body.candidates.find((c: { id: string }) => c.id === one.candidateId);
    expect(compared.competencies.find((c: { id: string }) => c.id === competencyIds[0]).evidence[0].quote).toContain('Evidence for');
  });

  it('links each compared candidate to their own assessment', async () => {
    const ids = await createDemoData();
    const one = await addApplicant({ ids, name: 'One Person', recommendation: 'PROCEED', overallScore: 80 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${one.candidateId},${ids.candidateId}`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === one.candidateId).assessmentId).toBe(one.assessmentId);
  });

  it('says plainly that availability is not something Questor records', async () => {
    const ids = await createDemoData();
    const one = await addApplicant({ ids, name: 'One Person', recommendation: 'PROCEED', overallScore: 80 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${one.candidateId},${ids.candidateId}`).set(auth(demoToken(ids)));
    expect(res.body.availabilityRecorded).toBe(false);
  });

  it('withholds the AI recommendation of a candidate this reviewer has not judged', async () => {
    const ids = await createDemoData();
    await requireBlind(ids.tenantId, true);
    const one = await addApplicant({ ids, name: 'One Person', recommendation: 'PROCEED', overallScore: 80 });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${one.candidateId},${ids.candidateId}`).set(auth(demoToken(ids)));
    const compared = res.body.candidates.find((c: { id: string }) => c.id === one.candidateId);
    expect({ pending: compared.blindReviewPending, rec: compared.recommendation }).toEqual({ pending: true, rec: undefined });
  });

  it('withholds that candidate\'s evidence quotes with the recommendation', async () => {
    const ids = await createDemoData();
    await requireBlind(ids.tenantId, true);
    const competencyIds = await roleCompetencyIds(ids.roleId);
    const one = await addApplicant({
      ids, name: 'One Person', recommendation: 'PROCEED', overallScore: 80,
      competencies: [competencyScore({ id: competencyIds[0], level: 4 })],
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${one.candidateId},${ids.candidateId}`).set(auth(demoToken(ids)));
    expect(res.body.candidates.find((c: { id: string }) => c.id === one.candidateId).competencies).toEqual([]);
  });
});

describe('object scope and tenant isolation', () => {
  async function secondRecruiter(ids: Awaited<ReturnType<typeof createDemoData>>) {
    const user = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'other-recruiter@example.com', name: 'Other', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'recruiter' },
    });
    // Something of their own, so an empty assignment list is not what denies them.
    const own = await prisma.role.create({
      data: { tenantId: ids.tenantId, title: 'Their Own Role', sourceType: 'paste', sourceText: DEMO_JD, status: 'approved', createdById: user.id },
    });
    await assignRole(own.id, user.id, 'owner');
    return signToken({ userId: user.id, tenantId: ids.tenantId, role: 'recruiter', email: 'other-recruiter@example.com' });
  }

  it("answers 404 for a colleague who is not on the role's team", async () => {
    const ids = await createDemoData();
    const token = await secondRecruiter(ids);
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(token));
    expect(res.status).toBe(404);
  });

  it('keeps the grid behind the same gate', async () => {
    const ids = await createDemoData();
    const token = await secondRecruiter(ids);
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/grid`).set(auth(token));
    expect(res.status).toBe(404);
  });

  it('keeps the side-by-side behind the same gate', async () => {
    const ids = await createDemoData();
    const token = await secondRecruiter(ids);
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates/comparison?ids=${ids.candidateId},x`).set(auth(token));
    expect(res.status).toBe(404);
  });

  it('keeps the shortlist behind the same gate', async () => {
    const ids = await createDemoData();
    const token = await secondRecruiter(ids);
    const res = await request(app).post(`/api/roles/${ids.roleId}/shortlist`).set(auth(token)).send({ candidateId: ids.candidateId });
    expect(res.status).toBe(404);
  });

  it('shows another tenant nothing of this role', async () => {
    const ids = await createDemoData();
    const other = await prisma.tenant.create({ data: { name: 'Other Org', region: 'in' } });
    const user = await prisma.user.create({
      data: { tenantId: other.id, email: 'admin@other.example.com', name: 'Other Admin', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'admin' },
    });
    const token = signToken({ userId: user.id, tenantId: other.id, role: 'admin', email: 'admin@other.example.com' });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(token));
    expect(res.status).toBe(404);
  });

  it('refuses an auditor, who holds no capability to read candidates', async () => {
    const ids = await createDemoData();
    const user = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'auditor@example.com', name: 'Auditor', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'auditor' },
    });
    await assignRole(ids.roleId, user.id, 'owner');
    const token = signToken({ userId: user.id, tenantId: ids.tenantId, role: 'auditor', email: 'auditor@example.com' });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(token));
    expect(res.status).toBe(403);
  });

  it('lets a recruiter assigned the role read its applicants', async () => {
    const ids = await createDemoData();
    const recruiter = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'scoped@example.com', name: 'Scoped', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'recruiter' },
    });
    await assignRole(ids.roleId, recruiter.id, 'owner');
    const token = signToken({ userId: recruiter.id, tenantId: ids.tenantId, role: 'recruiter', email: 'scoped@example.com' });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(token));
    expect(res.body.candidates.map((c: { id: string }) => c.id)).toEqual([ids.candidateId]);
  });

  it('never carries an applicant of a different role into this one', async () => {
    const ids = await createDemoData();
    const other = await prisma.role.create({
      data: { tenantId: ids.tenantId, title: 'Second Role', sourceType: 'paste', sourceText: DEMO_JD, status: 'approved', createdById: ids.userId },
    });
    await assignRole(other.id, ids.userId, 'owner');
    const elsewhere = await prisma.candidate.create({
      data: { tenantId: ids.tenantId, roleId: other.id, fullName: 'Elsewhere Person', email: 'elsewhere@example.com', emailNormalized: 'elsewhere@example.com' },
    });
    const res = await request(app).get(`/api/roles/${ids.roleId}/candidates`).set(auth(demoToken(ids)));
    expect(res.body.candidates.map((c: { id: string }) => c.id)).not.toContain(elsewhere.id);
  });
});
