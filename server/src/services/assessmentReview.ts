import { parseJson, parseJsonOptional, prisma } from '../db.js';
import { logger } from '../logger.js';
import type { AssessmentResult, RoleSuccessProfile } from '../domain/types.js';
import {
  assessmentDifferences, type AssessmentDifferences, type CompetencyDifference, type CompletedReview, type ReviewOverride,
} from '../domain/reviewedAssessment.js';

/**
 * Reading a completed human review, and the scorecard the role was approved
 * with, in one place.
 *
 * The review is the record the product acts on once it exists (see
 * domain/reviewedAssessment.ts) and the same row is what the candidate's
 * feedback email must be written from, so both callers read it the same way —
 * including a damaged `overridesJson`, which loses the levels but never the
 * verdict.
 */

const REVIEW_COMPLETED = 'COMPLETED';

function readOverrides(raw: string, reviewId: string): ReviewOverride[] {
  const parsed = parseJson<unknown>(raw, null);
  if (!Array.isArray(parsed)) {
    if (raw && raw !== '[]') logger.error({ reviewId }, 'Human review overrides are unreadable; the levels are missing from the comparison');
    return [];
  }
  return parsed
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      competencyId: typeof entry.competencyId === 'string' ? entry.competencyId : '',
      from: entry.from,
      to: entry.to,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    }))
    .filter((o) => o.competencyId !== '');
}

function asCompleted(review: {
  id: string; reviewerId: string; disposition: string | null; reason: string | null; comments: string | null;
  completedAt: Date | null; overridesJson: string; aiVisibleBefore?: boolean | null;
}): CompletedReview {
  return {
    id: review.id,
    reviewerId: review.reviewerId,
    disposition: review.disposition ?? '',
    reason: review.reason ?? '',
    comments: review.comments ?? '',
    completedAt: review.completedAt,
    overrides: readOverrides(review.overridesJson, review.id),
    aiVisibleBefore: review.aiVisibleBefore ?? null,
  };
}

/**
 * The completed review this assessment is acted on, or null. A superseded
 * review is not it: it was replaced deliberately, with a reason on the record.
 */
export async function completedReviewFor(assessmentId: string): Promise<CompletedReview | null> {
  const review = await prisma.humanReview.findFirst({
    where: { assessmentId, status: REVIEW_COMPLETED, supersededAt: null },
    orderBy: { completedAt: 'desc' },
  });
  return review ? asCompleted(review) : null;
}

// ---------------------------------------------------------------------------
// The record of the differences
// ---------------------------------------------------------------------------

/**
 * Write down where this review parted company with the AI. Once per review,
 * at the moment it is completed, so the comparison is durable and can be
 * analysed later without recomputing it from whatever the two rows look like
 * by then. Nothing about the candidate goes in beyond the assessment id.
 */
export async function recordReviewDifference(tenantId: string, assessmentId: string, reviewId: string): Promise<void> {
  const [assessment, review] = await Promise.all([
    prisma.assessmentVersion.findUnique({ where: { id: assessmentId }, select: { resultJson: true } }),
    prisma.humanReview.findUnique({ where: { id: reviewId } }),
  ]);
  if (!assessment || !review) return;
  const result = parseJson<AssessmentResult | null>(assessment.resultJson, null);
  if (!result || !Array.isArray(result.competencies)) {
    logger.error({ assessmentId, reviewId }, 'Assessment result unreadable; the review difference was not recorded');
    return;
  }
  const differences = assessmentDifferences(result, asCompleted(review));
  if (!differences) return;
  const changedCount = differences.competencies.filter((c) => c.changed).length;
  const data = {
    tenantId, assessmentId, reviewerId: review.reviewerId,
    aiRecommendation: differences.disposition.ai, humanDisposition: differences.disposition.human,
    agreed: differences.disposition.agreed, changedCount, competencyCount: differences.competencies.length,
    competenciesJson: JSON.stringify(differences.competencies), reason: differences.reason, summary: differences.summary,
  };
  await prisma.reviewDifference.upsert({ where: { reviewId }, create: { reviewId, ...data }, update: data });
}

/**
 * The differences as the assessment page shows them: read from the record,
 * and written first for a review completed before the record existed.
 * `comments` come from the review itself — they are the reviewer's free text
 * about a person and are not copied into the analysis record.
 */
export async function reviewDifferenceView(
  tenantId: string, assessmentId: string, review: CompletedReview | null,
): Promise<AssessmentDifferences | null> {
  if (!review) return null;
  let stored = await prisma.reviewDifference.findUnique({ where: { reviewId: review.id } });
  if (!stored) {
    await recordReviewDifference(tenantId, assessmentId, review.id);
    stored = await prisma.reviewDifference.findUnique({ where: { reviewId: review.id } });
    if (!stored) return null;
  }
  const competencies = parseJson<CompetencyDifference[]>(stored.competenciesJson, []);
  return {
    competencies: Array.isArray(competencies) ? competencies : [],
    disposition: { ai: stored.aiRecommendation, human: stored.humanDisposition, agreed: stored.agreed },
    reason: stored.reason,
    comments: review.comments,
    reviewerId: stored.reviewerId,
    reviewedAt: review.completedAt,
    summary: stored.summary,
  };
}

/**
 * The approved scorecard behind an assessment: where "what the role asks for"
 * in the candidate's letter comes from. Null when it cannot be read, and the
 * letter then says what the competency is in plainer words rather than
 * inventing a requirement.
 */
export async function scorecardProfileFor(scorecardId: string): Promise<RoleSuccessProfile | null> {
  const scorecard = await prisma.roleScorecardVersion.findUnique({ where: { id: scorecardId }, select: { profileJson: true } });
  if (!scorecard) return null;
  const profile = parseJsonOptional<RoleSuccessProfile | null>(
    scorecard.profileJson, null, { model: 'RoleScorecardVersion', id: scorecardId, field: 'profileJson' },
  );
  return profile && Array.isArray(profile.competencies) ? profile : null;
}
