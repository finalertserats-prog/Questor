// Seed enough reviewed interviews for the Admin console's Calibration tab to
// have something real to show: one competency where reviewers consistently read
// the evidence lower than the model, one they agree about, and one where they
// disagree with each other — so the page shows an applied adjustment, a held
// one, and the reason each is what it is. Usage:
//   DATABASE_URL=file:<abs>/data/questor.db npx tsx e2e/scripts/seedCalibration.ts
//
// Development only: it writes candidates, sessions, assessments, reviews and
// the calibration observations straight through Prisma, into the demo tenant.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Enough to clear the evidence bar (15) and the outcome statistics' own floor (20). */
const COUNT = 26;
const REVIEWERS = 4;
const DAY = 86_400_000;

/** What reviewers wrote, so the themes have something real to group. */
const REASONS = [
  'A strong answer here names the outcome, not just the action they took.',
  'They described the situation well but never said what changed as a result.',
  'No measurable result anywhere in this; the model read fluency as depth.',
  'Good detail on the steps, nothing on what it achieved or who it affected.',
  'The trade-off they made was the interesting part and it went unexamined.',
];

async function main() {
  const now = Date.now();
  const tenant = await prisma.tenant.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true, policyJson: true } });

  // Calibration is off by default; the screenshot is of it working.
  const policy = JSON.parse(tenant.policyJson || '{}') as Record<string, unknown>;
  await prisma.tenant.update({
    where: { id: tenant.id },
    data: { policyJson: JSON.stringify({ ...policy, calibrationEnabled: true }) },
  });

  const role = await prisma.role.findFirstOrThrow({
    where: { tenantId: tenant.id },
    select: {
      id: true, experienceBand: true,
      scorecards: { select: { id: true, profileJson: true }, orderBy: { version: 'desc' }, take: 1 },
    },
  });
  const scorecard = role.scorecards[0];
  if (!scorecard) throw new Error('Seed the demo data first: that role has no scorecard.');
  const scorecardId = scorecard.id;

  // The role's OWN competencies, so the page shows the names an organisation
  // would really see — including whatever acronyms they typed.
  const profile = JSON.parse(scorecard.profileJson) as { competencies: Array<{ id: string; name: string }> };
  const COMPETENCIES = profile.competencies.slice(0, 3);
  if (COMPETENCIES.length < 3) throw new Error('That scorecard has fewer than three competencies to work with.');
  const [gap, agreed, split] = COMPETENCIES as [typeof COMPETENCIES[0], typeof COMPETENCIES[0], typeof COMPETENCIES[0]];
  console.log(`Using: ${gap.name} (a real gap), ${agreed.name} (agreed), ${split.name} (reviewers split).`);

  const candidate = await prisma.candidate.findFirstOrThrow({ where: { tenantId: tenant.id }, select: { id: true } });

  const reviewerIds: string[] = [];
  for (let i = 0; i < REVIEWERS; i += 1) {
    const email = `calibration.reviewer${i}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      create: { tenantId: tenant.id, email, name: `Reviewer ${i + 1}`, role: 'reviewer', passwordHash: 'seeded-not-a-login' },
      update: {},
      select: { id: true },
    });
    reviewerIds.push(user.id);
  }

  for (let i = 0; i < COUNT; i += 1) {
    const reviewerId = reviewerIds[i % REVIEWERS]!;
    const observedAt = new Date(now - (COUNT - i) * 3 * DAY);

    const session = await prisma.interviewSession.create({
      data: {
        tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId,
        state: 'HUMAN_REVIEWED', completedAt: observedAt, startedAt: observedAt,
      },
    });

    const result = {
      assessmentVersion: `A-seed-${i}`, roleScorecardVersion: scorecardId,
      recommendation: 'PROCEED', confidence: 0.78, evidenceCoverage: 0.8, overallScore: 76,
      competencies: COMPETENCIES.map((c) => ({
        id: c.id, name: c.name, level: 4, requiredLevel: 3, confidence: 0.8,
        notEnoughEvidence: false, rationale: 'Seeded for the calibration view.',
        rubricVersion: scorecardId, evidence: [],
      })),
      strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [],
      summary: 'Seeded assessment.',
    };
    const assessment = await prisma.assessmentVersion.create({
      data: {
        sessionId: session.id, scorecardId, recommendation: 'PROCEED', confidence: 0.78,
        evidenceCoverage: 0.8, resultJson: JSON.stringify(result), createdAt: observedAt,
      },
    });

    // The first competency: everyone reads it a level lower — a real gap.
    // The second: everyone agrees with the model.
    // The third: reviewers split, so it is measured and never applied.
    const splitLevel = i % 2 === 0 ? 5 : 3;
    const review = await prisma.humanReview.create({
      data: {
        assessmentId: assessment.id, reviewerId, status: 'COMPLETED', disposition: i % 5 === 0 ? 'CONSIDER' : 'PROCEED',
        activeForAssessmentId: assessment.id, completedAt: observedAt, createdAt: observedAt,
        reason: 'My own read of the evidence.',
        overridesJson: JSON.stringify([
          { competencyId: gap.id, from: 4, to: 3, reason: REASONS[i % REASONS.length] },
          { competencyId: split.id, from: 4, to: splitLevel, reason: '' },
        ]),
      },
    });

    // Both records the product writes at review time: the difference the
    // reviewer-pattern statistics read, and the observations calibration folds.
    const { recordReviewDifference } = await import('../../server/src/services/assessmentReview.js');
    const { recordCalibrationObservations } = await import('../../server/src/services/calibrationCapture.js');
    await recordReviewDifference(tenant.id, assessment.id, review.id);
    await prisma.reviewDifference.updateMany({ where: { reviewId: review.id }, data: { createdAt: observedAt } });
    await recordCalibrationObservations({ tenantId: tenant.id, assessmentId: assessment.id, reviewId: review.id });
    await prisma.calibrationObservation.updateMany({ where: { reviewId: review.id }, data: { observedAt } });
  }

  const { runCalibration } = await import('../../server/src/services/calibrationActivation.js');
  const { refreshPatternAlerts } = await import('../../server/src/services/reviewerPatterns.js');
  await refreshPatternAlerts(tenant.id);
  const result = await runCalibration(tenant.id);
  console.log(`Seeded ${COUNT} reviewed interviews across ${REVIEWERS} reviewers.`);
  console.log(`Calibration: ${result.activated} activated, ${result.held} held, ${result.groups} groups.`);
}

main()
  .catch((err: unknown) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
