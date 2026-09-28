import { Prisma, type SmeReview } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import { smeRecommendationLabel, type SmeRecommendation } from '../domain/smeRecommendation.js';

/**
 * Writing and reading a subject-matter expert's recommendation.
 *
 * Nothing in this file touches a pipeline, and that absence is the feature.
 * services/pipelineAutonomy.ts is what moves a candidate between stages, and it
 * is reached from exactly two places — a completed HumanReview and an explicit
 * decision by someone holding `assessment:review`. An SME holds neither, writes
 * to neither table, and this module imports neither module. "An SME
 * recommendation never moves anyone" is therefore something you can check by
 * reading the imports, rather than something you have to trust.
 */

export interface SmeReviewInput {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly roleId: string;
  readonly sessionId: string | null;
  readonly smeUserId: string;
  readonly recommendation: SmeRecommendation;
  readonly feedback: string;
  readonly requestId?: string;
}

/**
 * Record or revise this expert's recommendation.
 *
 * One row per (candidate, role, expert), so a second submit revises the first
 * rather than adding a second opinion from the same person — and the unique
 * constraint is what decides it, not a check in here. A read-then-write would
 * let two submits arriving together both find nothing and both insert, and HR
 * would be shown one expert recommending both ways at once with no way to tell
 * which they meant. The database refuses that; a check here could only fail to.
 */
export async function saveSmeReview(input: SmeReviewInput): Promise<{ review: SmeReview; created: boolean }> {
  const key = {
    candidateId_roleId_smeUserId: {
      candidateId: input.candidateId, roleId: input.roleId, smeUserId: input.smeUserId,
    },
  };

  // Insert first and let the unique constraint answer, rather than reading to
  // find out whether this is the first time.
  //
  // A read followed by an upsert gets the ROW right — one of the two writes
  // wins and the content is whichever landed last — but it gets the STORY
  // wrong, and the story is what the audit trail keeps: two submits arriving
  // together both read "nothing here", both answer 201, and both write
  // `sme.review_recorded`, so the log says an expert recorded a first
  // recommendation twice and never revised one. Here the create either
  // succeeded or it did not, and `created` is exactly that fact.
  let existing: { readonly recommendation: string } | null = null;
  let review = await prisma.smeReview.create({
    data: {
      tenantId: input.tenantId,
      candidateId: input.candidateId,
      roleId: input.roleId,
      sessionId: input.sessionId,
      smeUserId: input.smeUserId,
      recommendation: input.recommendation,
      feedback: input.feedback,
    },
  }).catch((err: unknown) => {
    // P2002 is this expert already having a recommendation on this candidate
    // and role, which is a revision. Anything else is a fault.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  });

  if (!review) {
    existing = await prisma.smeReview.findUnique({ where: key, select: { recommendation: true } });
    review = await prisma.smeReview.update({
      where: key,
      data: {
        // Not tenantId, candidateId, roleId or smeUserId: those identify the
        // row and an update that could change them would be a way to move one
        // expert's recommendation onto another candidate.
        sessionId: input.sessionId,
        recommendation: input.recommendation,
        feedback: input.feedback,
      },
    });
  }

  // The recommendation itself is in the audit record, but not the written
  // reasoning: it names a candidate, it can be long, and the audit log is read
  // by an auditor whose whole grant is "sees that things happened, not
  // candidate detail". The row is where the reasoning lives.
  await logAudit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorId: input.smeUserId,
    action: existing ? 'sme.review_revised' : 'sme.review_recorded',
    entityType: 'SmeReview',
    entityId: review.id,
    requestId: input.requestId,
    ...(existing ? { before: { recommendation: existing.recommendation } } : {}),
    after: { candidateId: input.candidateId, roleId: input.roleId, recommendation: input.recommendation },
  });

  return { review, created: existing === null };
}

/** This expert's own recommendation on this candidate, or null. */
export async function ownSmeReview(candidateId: string, roleId: string, smeUserId: string): Promise<SmeReview | null> {
  return prisma.smeReview.findUnique({
    where: { candidateId_roleId_smeUserId: { candidateId, roleId, smeUserId } },
  });
}

export interface SmeReviewView {
  readonly id: string;
  readonly sme: { readonly id: string; readonly name: string };
  readonly recommendation: string;
  readonly recommendationLabel: string;
  readonly feedback: string;
  readonly sessionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Every expert's recommendation on this candidate, for the hiring team.
 *
 * The expert's name travels with it, and deliberately so: a recommendation
 * whose author is anonymous cannot be weighed, cannot be asked about, and
 * cannot be calibrated against later. That is also why invitations exist rather
 * than admin-chosen passwords — attribution is the thing this surface is built
 * out of (docs/credentials-contract.md §4).
 */
export async function smeReviewsForCandidate(tenantId: string, candidateId: string): Promise<SmeReviewView[]> {
  const rows = await prisma.smeReview.findMany({
    where: { tenantId, candidateId },
    orderBy: { updatedAt: 'desc' },
  });
  if (rows.length === 0) return [];

  const authors = await prisma.user.findMany({
    where: { id: { in: rows.map((row) => row.smeUserId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(authors.map((author) => [author.id, author.name]));

  return rows.map((row) => ({
    id: row.id,
    // A review whose author's account has since been removed still happened.
    // Dropping the row would rewrite the record; saying so is honest.
    sme: { id: row.smeUserId, name: nameOf.get(row.smeUserId) ?? 'A former colleague' },
    recommendation: row.recommendation,
    recommendationLabel: smeRecommendationLabel(row.recommendation),
    feedback: row.feedback,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * The role a review is written against.
 *
 * A candidate with no role has no approved scorecard, so there is nothing to
 * assess them against and no `roleId` to store. Refused in as many words rather
 * than stored against an empty string, which would make every such review
 * collide on the unique constraint with every other one.
 */
export function requireCandidateRole(roleId: string | null): string {
  if (!roleId) {
    throw new HttpError(409, 'This candidate is not attached to a role yet, so there is no scorecard to assess them against.');
  }
  return roleId;
}
