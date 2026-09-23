// Anchors and questions: the two things calibration reaches besides the score.
//
// ANCHORS. Where reviewers' reasons cluster on WHAT A STRONG ANSWER CONTAINS,
// that is not really a scoring gap — it is the rubric being out of date. So the
// themes become a PROPOSED anchor revision, and it goes through the approval
// path that already governs rubric changes: a draft scorecard version that
// somebody with `role:approve_scorecard` approves (services/scorecardVersions.ts,
// POST /api/roles/:id/approve). Calibration never edits a live standard. An
// approved scorecard is never rewritten in place, by anyone, and this feature
// does not get an exception.
//
// QUESTIONS. Where reviewers consistently discount what a question produced,
// the library already has somewhere to put that: `LibraryUsage.reviewerDelta`,
// a column its quality loop was built around and which nothing has ever
// written. Calibration is the producer it was waiting for. The library decides
// what to do about it — retire, replace, or nothing. This lane only tells it
// what reviewers did.

import { parseJson, prisma } from '../db.js';
import { logger } from '../logger.js';
import type { CalibrationAggregate } from '../domain/calibration.js';
import type { InterviewPlan, PlanBlock } from '../domain/types.js';
import { logAudit } from './audit.js';
import type { CalibrationGroup, ReasonTheme } from './calibrationAggregate.js';

/** Themes must be this widely held before they are put to a rubric approver. */
const MIN_THEME_COUNT = 3;
const MAX_PROPOSED_ANCHORS = 8;

/**
 * Turn the themes about strong answers into a proposed anchor revision.
 *
 * Proposed, and nothing more: the row is a suggestion sitting in the admin
 * view until a person with the capability to approve a rubric change acts on
 * it. Recomputed in place, so a proposal nobody has acted on tracks the
 * evidence rather than going stale beside it.
 */
export async function proposeAnchorsFrom(opts: {
  readonly group: CalibrationGroup;
  readonly themes: readonly ReasonTheme[];
  readonly aggregate: CalibrationAggregate;
  readonly competencyName: string;
}): Promise<void> {
  const useful = opts.themes.filter((t) => t.aboutStrongAnswers && t.count >= MIN_THEME_COUNT);
  const key = {
    tenantId_roleId_competencyId_band: {
      tenantId: opts.group.tenantId, roleId: opts.group.roleId,
      competencyId: opts.group.competencyId, band: opts.group.band,
    },
  };

  if (useful.length === 0) {
    // Nothing to propose. An existing proposal nobody decided is marked stale
    // rather than deleted: it was true when it was written, and the record of
    // what the evidence once said is worth keeping.
    await prisma.calibrationAnchorProposal.updateMany({
      where: {
        tenantId: opts.group.tenantId, roleId: opts.group.roleId,
        competencyId: opts.group.competencyId, band: opts.group.band, status: 'proposed',
      },
      data: { status: 'stale' },
    });
    return;
  }

  const anchors = useful.slice(0, MAX_PROPOSED_ANCHORS).map((t) => t.label);
  const existing = await prisma.calibrationAnchorProposal.findUnique({ where: key });
  // A decided proposal is not reopened by a later run. Somebody looked at it.
  if (existing && (existing.status === 'applied' || existing.status === 'declined')) return;

  const data = {
    roleKey: opts.group.roleKey,
    competencyKey: opts.group.competencyKey,
    status: 'proposed',
    themesJson: JSON.stringify(useful),
    anchorsJson: JSON.stringify(anchors),
    observations: opts.aggregate.observations,
    reviewers: opts.aggregate.reviewers,
    scorecardId: opts.group.scorecardId,
  };
  const row = await prisma.calibrationAnchorProposal.upsert({
    where: key,
    create: {
      tenantId: opts.group.tenantId, roleId: opts.group.roleId,
      competencyId: opts.group.competencyId, band: opts.group.band, ...data,
    },
    update: data,
  });
  if (!existing) {
    await logAudit({
      tenantId: opts.group.tenantId, actorType: 'system', action: 'calibration.anchors.proposed',
      entityType: 'CalibrationAnchorProposal', entityId: row.id,
      after: { competency: opts.competencyName, band: opts.group.band, anchors, reviewers: opts.aggregate.reviewers },
    });
  }
}

export class AnchorProposalNotFound extends Error {}

/**
 * Record that a person decided what to do with a proposal.
 *
 * "applied" does NOT edit anything here: the person applies it by editing the
 * role's scorecard, which creates a draft version their approver must approve.
 * This records that they did, so the proposal stops being offered and the
 * decision is on the audit trail with the rubric change it belongs to.
 */
export async function decideAnchorProposal(opts: {
  readonly tenantId: string;
  readonly proposalId: string;
  readonly decision: 'applied' | 'declined';
  readonly actorId: string;
  readonly reason: string;
}): Promise<void> {
  const row = await prisma.calibrationAnchorProposal.findFirst({
    where: { id: opts.proposalId, tenantId: opts.tenantId },
  });
  if (!row) throw new AnchorProposalNotFound('That anchor proposal is not one of this organisation\'s.');
  await prisma.calibrationAnchorProposal.update({
    where: { id: row.id },
    data: { status: opts.decision, decidedById: opts.actorId, decidedAt: new Date(), decidedReason: opts.reason },
  });
  await logAudit({
    tenantId: opts.tenantId, actorId: opts.actorId, actorType: 'user',
    action: `calibration.anchors.${opts.decision}`,
    entityType: 'CalibrationAnchorProposal', entityId: row.id,
    before: { status: row.status },
    after: { status: opts.decision, reason: opts.reason, anchors: parseJson<string[]>(row.anchorsJson, []) },
  });
}

export interface AnchorProposalView {
  readonly id: string;
  readonly roleId: string;
  readonly competencyId: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly status: string;
  readonly anchors: readonly string[];
  readonly themes: readonly ReasonTheme[];
  readonly observations: number;
  readonly reviewers: number;
  readonly createdAt: string;
}

export async function anchorProposalsFor(tenantId: string): Promise<AnchorProposalView[]> {
  const rows = await prisma.calibrationAnchorProposal.findMany({
    where: { tenantId }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    roleId: row.roleId,
    competencyId: row.competencyId,
    competencyKey: row.competencyKey,
    band: row.band,
    status: row.status,
    anchors: parseJson<string[]>(row.anchorsJson, []),
    themes: parseJson<ReasonTheme[]>(row.themesJson, []),
    observations: row.observations,
    reviewers: row.reviewers,
    createdAt: row.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// The signal the library's quality loop already consumes
// ---------------------------------------------------------------------------

/**
 * Write `reviewerDelta` onto the library usage rows for this review.
 *
 * The meaning, stated once so the library and this lane cannot drift: the
 * signed difference between the human's level and the model's for the
 * competency that question was asked under. Negative means reviewers read the
 * answer as weaker than the model did — which, repeated across many interviews
 * on one question, is the library's own evidence that the question is not
 * producing evidence worth much.
 *
 * This lane emits the signal. It does not retire anything: what to do about a
 * question is the library's decision, through its own lifecycle and its own
 * approval path.
 */
export async function recordLibraryReviewerDelta(opts: {
  readonly assessmentId: string;
  readonly reviewId: string;
}): Promise<number> {
  try {
    const observations = await prisma.calibrationObservation.findMany({
      where: { reviewId: opts.reviewId, delta: { not: null } },
      select: { competencyId: true, delta: true },
    });
    if (observations.length === 0) return 0;

    const assessment = await prisma.assessmentVersion.findUnique({
      where: { id: opts.assessmentId },
      select: { sessionId: true, session: { select: { plan: { select: { planJson: true } } } } },
    });
    if (!assessment?.session.plan) return 0;

    const plan = parseJson<InterviewPlan | null>(assessment.session.plan.planJson, null);
    if (!plan || !Array.isArray(plan.blocks)) return 0;

    const deltaByCompetency = new Map(observations.map((o) => [o.competencyId, o.delta as number]));
    // Only blocks the library actually planned have a usage row to carry this.
    const libraryBlocks = plan.blocks.filter((b): b is PlanBlock => b?.library?.source === 'library');
    if (libraryBlocks.length === 0) return 0;

    let written = 0;
    for (const block of libraryBlocks) {
      const delta = deltaByCompetency.get(block.competencyId);
      if (delta === undefined) continue;
      const updated = await prisma.libraryUsage.updateMany({
        where: { interviewSessionId: assessment.sessionId, competencyId: block.competencyId },
        data: { reviewerDelta: delta },
      });
      written += updated.count;
    }
    return written;
  } catch (err) {
    // Best effort, like every other library-usage write: a review must complete.
    logger.warn({ err: String(err), reviewId: opts.reviewId }, 'The reviewer-delta signal was not written to the library usage rows');
    return 0;
  }
}
