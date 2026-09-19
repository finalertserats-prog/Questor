import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { getAgreementReport, BLIND_REVIEW_STATUS } from '../src/services/shadowMode.js';

/**
 * A blind verdict whose competency overrides cannot be read shrinks the sample.
 *
 * `parseJson(review.overridesJson, [])` turned a damaged row into "this
 * reviewer graded no competencies", so the pairs silently vanished from the
 * competency-level kappa. The report then described a sample that was smaller
 * than it claimed — and the whole point of this harness is that it never
 * reports a number more flattering than the data supports.
 */

const AI_RESULT = JSON.stringify({
  recommendation: 'CONSIDER',
  overallScore: 68,
  competencies: [
    { id: 'sql', name: 'SQL', level: 3, notEnoughEvidence: false },
    { id: 'modelling', name: 'Data modelling', level: 4, notEnoughEvidence: false },
  ],
});

/** One blind verdict against one assessment, with the overrides written as given. */
async function blindVerdictWithOverrides(overridesJson: string) {
  await wipe();
  const ids = await createDemoData();
  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId: ids.sessionId, scorecardId: ids.scorecardId,
      recommendation: 'CONSIDER', resultJson: AI_RESULT,
    },
  });
  await prisma.humanReview.create({
    data: {
      assessmentId: assessment.id, reviewerId: ids.userId, status: BLIND_REVIEW_STATUS,
      disposition: 'CONSIDER', reason: 'Solid but not deep.', overridesJson,
    },
  });
  return ids.tenantId;
}

const GOOD_OVERRIDES = JSON.stringify([{ competencyId: 'sql', to: 3 }, { competencyId: 'modelling', to: 4 }]);

describe('a blind verdict whose overrides cannot be parsed', () => {
  it('is counted, and the count is reported', async () => {
    const tenantId = await blindVerdictWithOverrides('[{"competencyId":"sql","to":3');

    const report = await getAgreementReport(tenantId);

    expect(report.blindingBypassed?.note).toMatch(/1 blind verdict/);
  });

  it('says nothing about unreadable overrides when every row parses', async () => {
    const tenantId = await blindVerdictWithOverrides(GOOD_OVERRIDES);

    const report = await getAgreementReport(tenantId);

    expect(report.blindingBypassed?.note).not.toMatch(/unreadable/i);
  });

  it('still counts the verdict itself, because the disposition was readable', async () => {
    // Only the competency levels are lost. Dropping the whole observation would
    // shrink the sample further for no reason.
    const tenantId = await blindVerdictWithOverrides('not json at all');

    const report = await getAgreementReport(tenantId);

    expect(report.sampleSize.blindVerdicts).toBe(1);
  });
});
