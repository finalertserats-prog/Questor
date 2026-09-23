import { prisma } from '../db.js';
import { BLIND_REVIEW_STATUS } from './shadowModeCommon.js';
import { UNBLINDED_READ_ACTION } from './shadowModeBlind.js';

/**
 * Was the AI's reading available to this reviewer before they recorded their
 * verdict? Answered once, at the moment the review is written, and stored on
 * the row (HumanReview.aiVisibleBefore).
 *
 * The evidence is two events and their order:
 *
 *   - a BLIND review row by this reviewer for this assessment — the verdict
 *     they filed from the transcript and the evidence alone;
 *   - the first time they opened the AI's conclusions, which is either the
 *     unblinded-read event (they went straight to the assessment) or the
 *     reveal (they unlocked it after judging blind).
 *
 * A blind verdict that came first means the judgement was formed independently
 * and this review carries it forward. A blind verdict filed AFTER the AI was
 * on screen is not blind, whatever the row is called, so the order is compared
 * rather than the existence of the row.
 *
 * Absent evidence, the answer is `true`. That is the conservative direction on
 * purpose: claiming independence we cannot show would be inventing the very
 * thing the record exists to prove.
 */

/** Written when the reviewer unlocks the AI's reading after judging blind. */
const AI_REVEALED_ACTION = 'review.ai_revealed';

export async function aiVisibleBeforeReview(assessmentId: string, reviewerId: string): Promise<boolean> {
  const [blind, seen] = await Promise.all([
    prisma.humanReview.findFirst({
      where: { assessmentId, reviewerId, status: BLIND_REVIEW_STATUS },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.auditEvent.findFirst({
      where: { entityId: assessmentId, actorId: reviewerId, action: { in: [UNBLINDED_READ_ACTION, AI_REVEALED_ACTION] } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);
  if (!blind) return true;
  if (!seen) return false;
  return blind.createdAt > seen.createdAt;
}
