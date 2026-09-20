import { parseJson, parseJsonOptional, prisma } from '../db.js';
import { logger } from '../logger.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import type { CompletedReview, ReviewOverride } from '../domain/reviewedAssessment.js';

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

/** The most recent completed review of this assessment, or null. */
export async function completedReviewFor(assessmentId: string): Promise<CompletedReview | null> {
  const review = await prisma.humanReview.findFirst({
    where: { assessmentId, status: REVIEW_COMPLETED },
    orderBy: { completedAt: 'desc' },
  });
  if (!review) return null;
  return {
    id: review.id,
    reviewerId: review.reviewerId,
    disposition: review.disposition ?? '',
    reason: review.reason ?? '',
    comments: review.comments ?? '',
    completedAt: review.completedAt,
    overrides: readOverrides(review.overridesJson, review.id),
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
