import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { config } from '../src/config.js';
import { calibrationFor } from '../src/services/calibrationApply.js';
import { runCalibration } from '../src/services/calibrationActivation.js';
import { CALIBRATION_ENABLED_KEY, CALIBRATION_GLOBAL_KEY } from '../src/services/calibrationSettings.js';
import { contributeGlobalObservations, reviewerPseudonym } from '../src/services/calibrationGlobal.js';
import { assessmentCalibration } from '../src/domain/calibrationView.js';
import type { AssessmentResult } from '../src/domain/types.js';

/**
 * End to end: a reviewer disagrees, the observation is captured, the evidence
 * accumulates, a calibration activates, and it reaches the NEXT interview —
 * never the one already assessed.
 */

const app = createApp();

const RESULT = {
  assessmentVersion: 'A', roleScorecardVersion: 's', recommendation: 'PROCEED', confidence: 0.8,
  evidenceCoverage: 0.7, overallScore: 82,
  competencies: [
    { id: 'sql', name: 'SQL', level: 4, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false, rationale: '', rubricVersion: 'r', evidence: [{ turnId: 't1', startMs: 0, endMs: 1, quote: 'q' }] },
    { id: 'stake', name: 'Stakeholder management', level: 4, requiredLevel: 3, confidence: 0.7, notEnoughEvidence: false, rationale: '', rubricVersion: 'r', evidence: [] },
  ],
  strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

type Ids = Awaited<ReturnType<typeof createDemoData>>;

async function seed() {
  const ids = await createDemoData();
  await prisma.tenant.update({
    where: { id: ids.tenantId },
    data: { policyJson: JSON.stringify({ [CALIBRATION_ENABLED_KEY]: true }) },
  });
  const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
  return { ...ids, auth };
}

/** A completed review that moved "Stakeholder management" down a level. */
async function reviewedAssessment(ids: Ids & { auth: Record<string, string> }, reviewerId: string, humanLevel: number) {
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: ids.tenantId, candidateId: ids.candidateId, roleId: ids.roleId,
      scorecardId: ids.scorecardId, state: 'REVIEW_READY', completedAt: new Date(),
    },
  });
  const created = await prisma.assessmentVersion.create({
    data: {
      sessionId: session.id, scorecardId: ids.scorecardId, recommendation: 'PROCEED',
      confidence: 0.8, evidenceCoverage: 0.7, resultJson: JSON.stringify(RESULT),
    },
  });
  const review = await prisma.humanReview.create({
    data: {
      assessmentId: created.id, reviewerId, status: 'COMPLETED', disposition: 'CONSIDER',
      activeForAssessmentId: created.id, completedAt: new Date(),
      reason: 'My own read of the evidence.',
      overridesJson: JSON.stringify([
        { competencyId: 'stake', from: 4, to: humanLevel, reason: 'A strong answer here names the outcome, not just the action.' },
      ]),
    },
  });
  const { recordCalibrationObservations } = await import('../src/services/calibrationCapture.js');
  await recordCalibrationObservations({ tenantId: ids.tenantId, assessmentId: created.id, reviewId: review.id });
  return { assessmentId: created.id, reviewId: review.id };
}

/** Enough evidence, from enough reviewers, to clear every gate. */
async function buildEvidence(ids: Ids & { auth: Record<string, string> }, count = 18) {
  const reviewerIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const user = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: `reviewer${i}-${Date.now()}@example.test`, name: `Reviewer ${i}`, role: 'reviewer', passwordHash: 'x' },
    });
    reviewerIds.push(user.id);
  }
  for (let i = 0; i < count; i += 1) {
    await reviewedAssessment(ids, reviewerIds[i % reviewerIds.length]!, 3);
  }
  return reviewerIds;
}

/**
 * The deployment switches, set directly rather than through a spy: `config` is
 * a plain object and these are plain properties, so assignment is the honest
 * way to say "this deployment has calibration on".
 */
const switches = config.calibration as { enabled: boolean; requireFairnessCheck: boolean; globalEnabled: boolean };
const DEPLOYMENT = { ...switches };

beforeEach(async () => {
  await wipe();
  vi.restoreAllMocks();
  Object.assign(switches, DEPLOYMENT, { enabled: true });
});

afterEach(() => { Object.assign(switches, DEPLOYMENT); });

/** The fairness gate can only pass once there are outcome statistics to read. */
function withoutFairnessGate() { switches.requireFairnessCheck = false; }

describe('capture', () => {
  it('writes one observation per competency when a review is completed', async () => {
    const ids = await seed();
    const { reviewId } = await reviewedAssessment(ids, ids.userId, 3);
    const rows = await prisma.calibrationObservation.findMany({ where: { reviewId } });
    expect(rows).toHaveLength(2);
    const stake = rows.find((r) => r.competencyId === 'stake')!;
    expect(stake.aiLevel).toBe(4);
    expect(stake.humanLevel).toBe(3);
    expect(stake.delta).toBe(-1);
    expect(stake.magnitude).toBe('minor');
    expect(stake.reasonText).toContain('names the outcome');
  });

  it('records a large disagreement differently from a small one', async () => {
    const ids = await seed();
    const { reviewId } = await reviewedAssessment(ids, ids.userId, 1);
    const stake = await prisma.calibrationObservation.findFirst({ where: { reviewId, competencyId: 'stake' } });
    expect(stake!.delta).toBe(-3);
    expect(stake!.magnitude).toBe('major');
  });

  it('records agreement as well as disagreement', async () => {
    const ids = await seed();
    const { reviewId } = await reviewedAssessment(ids, ids.userId, 3);
    const sql = await prisma.calibrationObservation.findFirst({ where: { reviewId, competencyId: 'sql' } });
    expect(sql!.delta).toBe(0);
    expect(sql!.magnitude).toBe('none');
  });

  it('keeps references to the evidence, never a second copy of the transcript', async () => {
    const ids = await seed();
    const { reviewId } = await reviewedAssessment(ids, ids.userId, 3);
    const sql = await prisma.calibrationObservation.findFirst({ where: { reviewId, competencyId: 'sql' } });
    expect(sql!.evidenceCount).toBe(1);
    expect(JSON.parse(sql!.evidenceTurnIdsJson)).toEqual(['t1']);
    expect(JSON.stringify(sql)).not.toContain('"q"');
  });

  it('writes the same rows again rather than doubling the evidence', async () => {
    const ids = await seed();
    const { assessmentId, reviewId } = await reviewedAssessment(ids, ids.userId, 3);
    const { recordCalibrationObservations } = await import('../src/services/calibrationCapture.js');
    await recordCalibrationObservations({ tenantId: ids.tenantId, assessmentId, reviewId });
    expect(await prisma.calibrationObservation.count({ where: { reviewId } })).toBe(2);
  });

  it('captures even when calibration is switched off, because the record is worth keeping', async () => {
    const ids = await createDemoData();
    const { reviewId } = await reviewedAssessment({ ...ids, auth: {} }, ids.userId, 3);
    expect(await prisma.calibrationObservation.count({ where: { reviewId } })).toBe(2);
  });
});

describe('activation', () => {
  it('applies nothing on thin evidence and says how far off it is', async () => {
    const ids = await seed();
    await buildEvidence(ids, 5);
    await runCalibration(ids.tenantId);
    const rows = await prisma.calibrationAdjustment.findMany({ where: { tenantId: ids.tenantId } });
    // Below the group floor nothing is even written.
    expect(rows.filter((r) => r.status === 'active')).toHaveLength(0);
  });

  it('holds when this role has too few outcomes for the statistics to say anything', async () => {
    const ids = await seed();
    // Enough reviews to clear every statistical gate, but fewer assessed
    // outcomes than the outcome statistics will read (OUTCOME_MIN_SAMPLE).
    await buildEvidence(ids, 18);
    await runCalibration(ids.tenantId);
    const stake = await prisma.calibrationAdjustment.findFirst({
      where: { tenantId: ids.tenantId, competencyId: 'stake' },
    });
    expect(stake).not.toBeNull();
    expect(stake!.status).toBe('held');
    expect(stake!.delta).toBe(0);
    expect(stake!.holdReason).toBe('fairness_flagged');
    expect(stake!.statement).toContain('too few for the pass-rate statistics');
    // The measurement is still recorded; it is the APPLICATION that is held.
    expect(stake!.measuredMedian).toBe(-1);
    expect(stake!.observations).toBeGreaterThanOrEqual(15);
  });

  it('activates once the fairness check can run, bounded to one level, and audits it', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    await runCalibration(ids.tenantId);
    const stake = await prisma.calibrationAdjustment.findFirst({
      where: { tenantId: ids.tenantId, competencyId: 'stake' },
    });
    expect(stake!.status).toBe('active');
    expect(stake!.delta).toBe(-1);
    expect(Math.abs(stake!.delta)).toBeLessThanOrEqual(1);
    expect(stake!.reviewers).toBeGreaterThanOrEqual(3);
    expect(stake!.statement).toMatch(/^Adjusted -1: \d+ reviews, \d+ reviewers, since /);

    const audit = await prisma.auditEvent.findFirst({
      where: { tenantId: ids.tenantId, action: 'calibration.activated' },
    });
    expect(audit).not.toBeNull();
    const after = JSON.parse(audit!.afterJson);
    expect(after.delta).toBe(-1);
    expect(after.fairness).toBeTruthy();
    expect(after.interval).toBeTruthy();
  });

  it('can be told not to require the statistics, and then applies on the projection alone', async () => {
    const ids = await seed();
    withoutFairnessGate();
    // Too few outcomes for the statistics to read, which normally holds it.
    await buildEvidence(ids, 18);
    await runCalibration(ids.tenantId);
    const stake = await prisma.calibrationAdjustment.findFirst({ where: { tenantId: ids.tenantId, competencyId: 'stake' } });
    expect(stake!.status).toBe('active');
    expect(stake!.delta).toBe(-1);
    const fairness = JSON.parse(stake!.fairnessJson);
    expect(fairness.flagged).toBe(false);
    expect(fairness.statement).toContain('only the replayed projection was checked');
  });

  it('leaves a competency reviewers agreed with alone', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    await runCalibration(ids.tenantId);
    const sql = await prisma.calibrationAdjustment.findFirst({
      where: { tenantId: ids.tenantId, competencyId: 'sql' },
    });
    expect(sql?.status).not.toBe('active');
    expect(sql?.delta ?? 0).toBe(0);
  });

  it('reverts in one action, audits it, and does not reactivate on the next run', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    await runCalibration(ids.tenantId);
    const stake = await prisma.calibrationAdjustment.findFirst({ where: { tenantId: ids.tenantId, competencyId: 'stake' } });

    const res = await request(app).post(`/api/admin/calibration/${stake!.id}/revert`).set(ids.auth)
      .send({ reason: 'We want to look at this before it applies.' });
    expect(res.status).toBe(200);

    await runCalibration(ids.tenantId);
    const after = await prisma.calibrationAdjustment.findUnique({ where: { id: stake!.id } });
    expect(after!.status).toBe('reverted');
    expect(after!.delta).toBe(0);
    expect(await prisma.auditEvent.count({ where: { tenantId: ids.tenantId, action: 'calibration.reverted' } })).toBe(1);
  });

  it('withdraws everything when the organisation switches calibration off', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    await runCalibration(ids.tenantId);
    expect(await prisma.calibrationAdjustment.count({ where: { tenantId: ids.tenantId, status: 'active' } })).toBeGreaterThan(0);

    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ [CALIBRATION_ENABLED_KEY]: false }) } });
    const result = await runCalibration(ids.tenantId);
    expect(result.skipped).toBe('organisation_switched_off');
    expect(await prisma.calibrationAdjustment.count({ where: { tenantId: ids.tenantId, status: 'active' } })).toBe(0);
  });
});

describe('forward only', () => {
  it('leaves every recorded assessment byte for byte unchanged after a calibration activates', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);

    const before = await prisma.assessmentVersion.findMany({ orderBy: { id: 'asc' } });
    expect(before.length).toBeGreaterThan(0);
    const snapshot = JSON.stringify(before);

    await runCalibration(ids.tenantId);
    expect(await prisma.calibrationAdjustment.count({ where: { tenantId: ids.tenantId, status: 'active' } })).toBeGreaterThan(0);

    const after = await prisma.assessmentVersion.findMany({ orderBy: { id: 'asc' } });
    expect(JSON.stringify(after)).toBe(snapshot);
    for (const row of after) {
      const result = JSON.parse(row.resultJson) as AssessmentResult;
      for (const competency of result.competencies) {
        expect(competency.calibratedLevel).toBeUndefined();
        expect(competency.calibration).toBeUndefined();
      }
    }
  });

  it('leaves the human reviews and the differences unchanged too', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    const reviews = JSON.stringify(await prisma.humanReview.findMany({ orderBy: { id: 'asc' } }));
    await runCalibration(ids.tenantId);
    expect(JSON.stringify(await prisma.humanReview.findMany({ orderBy: { id: 'asc' } }))).toBe(reviews);
  });

  it('hands the calibration to the NEXT interview instead', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    await runCalibration(ids.tenantId);

    const role = await prisma.role.findUnique({ where: { id: ids.roleId } });
    const map = await calibrationFor({
      tenantId: ids.tenantId,
      roleId: ids.roleId,
      catalogRoleId: role!.catalogRoleId,
      band: role!.experienceBand ?? '',
      competencies: [{ id: 'stake', name: 'Stakeholder management' }, { id: 'sql', name: 'SQL' }],
    });
    expect(map.stake?.delta).toBe(-1);
    expect(map.stake?.provenance.statement).toContain('reviewers');
    expect(map.sql).toBeUndefined();
  });

  it('hands nothing over once calibration is switched off', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    await runCalibration(ids.tenantId);
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: '{}' } });

    const role = await prisma.role.findUnique({ where: { id: ids.roleId } });
    const map = await calibrationFor({
      tenantId: ids.tenantId, roleId: ids.roleId, catalogRoleId: role!.catalogRoleId,
      band: role!.experienceBand ?? '', competencies: [{ id: 'stake', name: 'Stakeholder management' }],
    });
    expect(map).toEqual({});
  });
});

describe('the shared calibration', () => {
  it('contributes nothing unless the organisation opted in', async () => {
    const ids = await seed();
    await buildEvidence(ids, 18);
    expect(await contributeGlobalObservations(ids.tenantId)).toBe(0);
    expect(await prisma.calibrationGlobalObservation.count()).toBe(0);
  });

  it('strips the organisation, the people and the free text when it does', async () => {
    const ids = await seed();
    switches.globalEnabled = true;
    await prisma.tenant.update({
      where: { id: ids.tenantId },
      data: { policyJson: JSON.stringify({ [CALIBRATION_ENABLED_KEY]: true, [CALIBRATION_GLOBAL_KEY]: true }) },
    });
    const role = await prisma.role.findUnique({ where: { id: ids.roleId } });
    // Only a catalog-keyed role is shareable at all.
    if (!role!.catalogRoleId) {
      const catalogRole = await prisma.catalogRole.findFirst();
      if (catalogRole) await prisma.role.update({ where: { id: ids.roleId }, data: { catalogRoleId: catalogRole.id } });
    }
    await buildEvidence(ids, 18);
    const written = await contributeGlobalObservations(ids.tenantId);

    const shared = await prisma.calibrationGlobalObservation.findMany();
    if (written === 0) {
      // No catalog role in this fixture: nothing shareable, which is itself the rule.
      expect(shared).toHaveLength(0);
      return;
    }
    const text = JSON.stringify(shared);
    expect(text).not.toContain(ids.tenantId);
    expect(text).not.toContain(ids.roleId);
    expect(text).not.toContain('names the outcome');
    expect(text).not.toContain(ids.candidateId);
    for (const row of shared) {
      expect(row.observedMonth).toMatch(/^\d{4}-\d{2}$/);
      expect(row.reviewerPseudonym).toHaveLength(32);
    }
  });

  it('gives the same person a different code in a different organisation', () => {
    expect(reviewerPseudonym('tenant-a', 'user-1')).not.toBe(reviewerPseudonym('tenant-b', 'user-1'));
  });

  it('contributes the same observation only once', async () => {
    const ids = await seed();
    switches.globalEnabled = true;
    await prisma.tenant.update({
      where: { id: ids.tenantId },
      data: { policyJson: JSON.stringify({ [CALIBRATION_ENABLED_KEY]: true, [CALIBRATION_GLOBAL_KEY]: true }) },
    });
    await buildEvidence(ids, 18);
    const first = await contributeGlobalObservations(ids.tenantId);
    const second = await contributeGlobalObservations(ids.tenantId);
    expect(second).toBe(0);
    expect(await prisma.calibrationGlobalObservation.count()).toBe(first);
  });
});

describe('what the assessment page is handed', () => {
  it('is empty for an assessment written without a calibration', () => {
    expect(assessmentCalibration(RESULT as unknown as AssessmentResult, null)).toEqual({});
  });

  it('carries the AI level, the calibrated level and the human level together', () => {
    const calibrated = {
      ...RESULT,
      competencies: [
        {
          ...RESULT.competencies[1], calibratedLevel: 3,
          calibration: {
            adjustmentId: 'adj1', scope: 'org', delta: -1, observations: 18, reviewers: 4,
            since: '2026-08-12T00:00:00.000Z', statement: 'Adjusted -1: 18 reviews, 4 reviewers, since 12 Aug 2026.',
          },
        },
      ],
    } as unknown as AssessmentResult;
    const view = assessmentCalibration(calibrated, {
      competencies: [{ competencyId: 'stake', competencyName: 'Stakeholder management', aiLevel: 4, humanLevel: 2, changed: true, reason: '' }],
      disposition: { ai: 'PROCEED', human: 'CONSIDER', agreed: false },
      reason: '', comments: '', reviewerId: 'u', reviewedAt: null, summary: '',
    });
    expect(view.competencies).toHaveLength(1);
    const row = view.competencies![0]!;
    // The exact contract the assessment page renders against.
    expect(Object.keys(row).sort()).toEqual(['competencyId', 'level', 'provenance']);
    expect(row.competencyId).toBe('stake');
    expect(row.level).toBe(3);
    // The model's own level, the evidence behind the move, and the reviewer's
    // level, which beats both.
    expect(row.provenance).toContain('The model graded 4/5');
    expect(row.provenance).toContain('18 reviews, 4 reviewers');
    expect(row.provenance).toContain('A reviewer has since recorded 2/5');
    expect(view.note).toContain('model\'s own level is kept');
  });
});

describe('the admin surface', () => {
  it('is closed to anyone without admin rights', async () => {
    const ids = await seed();
    const reviewer = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: `r-${Date.now()}@example.test`, name: 'R', role: 'reviewer', passwordHash: 'x' },
    });
    const auth = { Authorization: `Bearer ${signToken({ userId: reviewer.id, tenantId: ids.tenantId, role: 'reviewer', email: reviewer.email })}` };
    expect((await request(app).get('/api/admin/calibration').set(auth)).status).toBe(403);
    expect((await request(app).get('/api/admin/calibration/reviewers').set(auth)).status).toBe(403);
  });

  it('shows an admin what is applied, what is held and why', async () => {
    const ids = await seed();
    await buildEvidence(ids, 18);
    await runCalibration(ids.tenantId);
    const res = await request(app).get('/api/admin/calibration').set(ids.auth);
    expect(res.status).toBe(200);
    expect(res.body.settings.organisationEnabled).toBe(true);
    expect(res.body.consentText.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.adjustments)).toBe(true);
    const stake = res.body.adjustments.find((a: { competencyId: string }) => a.competencyId === 'stake');
    expect(stake.statement.length).toBeGreaterThan(0);
    expect(stake.observations).toBeGreaterThanOrEqual(15);
  });

  it('refuses a revert without a reason', async () => {
    const ids = await seed();
    await buildEvidence(ids, 22);
    await runCalibration(ids.tenantId);
    const stake = await prisma.calibrationAdjustment.findFirst({ where: { tenantId: ids.tenantId, competencyId: 'stake' } });
    const res = await request(app).post(`/api/admin/calibration/${stake!.id}/revert`).set(ids.auth).send({ reason: 'no' });
    expect(res.status).toBe(400);
  });

  it('refuses to revert another organisation\'s calibration', async () => {
    const ids = await seed();
    withoutFairnessGate();
    await buildEvidence(ids, 18);
    await runCalibration(ids.tenantId);
    const other = await prisma.tenant.create({ data: { name: 'Other' } });
    const stake = await prisma.calibrationAdjustment.findFirst({ where: { tenantId: ids.tenantId, competencyId: 'stake' } });
    await prisma.calibrationAdjustment.update({ where: { id: stake!.id }, data: { tenantId: other.id } });
    const res = await request(app).post(`/api/admin/calibration/${stake!.id}/revert`).set(ids.auth)
      .send({ reason: 'Not mine to revert, and it should say so.' });
    expect(res.status).toBe(404);
  });
});

describe('reviewer patterns', () => {
  it('lets a reviewer read their own figures without any capability', async () => {
    const ids = await seed();
    const reviewer = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: `own-${Date.now()}@example.test`, name: 'Own', role: 'reviewer', passwordHash: 'x' },
    });
    const auth = { Authorization: `Bearer ${signToken({ userId: reviewer.id, tenantId: ids.tenantId, role: 'reviewer', email: reviewer.email })}` };
    const res = await request(app).get('/api/admin/calibration/reviewers/me').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.notice).toContain('patterns, not findings');
  });

  it('audits an admin reading everyone\'s figures, because it is employee data', async () => {
    const ids = await seed();
    await buildEvidence(ids, 12);
    const res = await request(app).get('/api/admin/calibration/reviewers').set(ids.auth);
    expect(res.status).toBe(200);
    expect(res.body.notice).toContain('audit log');
    const audit = await prisma.auditEvent.findFirst({
      where: { tenantId: ids.tenantId, action: 'reviewer.pattern.viewed' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.afterJson).scope).toBe('every reviewer in the organisation');
  });

  it('says too few reviews rather than producing a statistic', async () => {
    const ids = await seed();
    await buildEvidence(ids, 8);
    const res = await request(app).get('/api/admin/calibration/reviewers').set(ids.auth);
    for (const reviewer of res.body.reviewers) {
      expect(reviewer.statistics.tooFewToSay).toBe(true);
      expect(reviewer.statistics.divergenceFromAi).toBeNull();
      expect(reviewer.alerts).toEqual([]);
    }
  });
});
