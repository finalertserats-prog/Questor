// Capture: turning a completed review into calibration observations.
//
// Written at the same moment as the ReviewDifference, from the same two rows.
// ReviewDifference is the record of one review, for the assessment page and
// the compliance trail. These are the unit the statistics need: one row per
// competency, keyed by role, competency and band so that a gap can be counted
// without reparsing every difference's JSON.
//
// THIS NEVER WRITES TO THE ASSESSMENT. It reads `resultJson` and writes rows of
// its own. The owner's rule — "I want it to learn, not just auto-change scores
// for an interview" — is enforced here by there being no code that could.
//
// Best-effort by construction: a review must complete even if none of this can
// be written. A failure is logged and swallowed, exactly as the library's usage
// recording is.

import { parseJson, parseJsonOptional, prisma } from '../db.js';
import { logger } from '../logger.js';
import type { AssessmentResult, InterviewPlan, RoleSuccessProfile } from '../domain/types.js';
import { competencyKeyOf, magnitudeOf, roleKeyOf } from '../domain/calibration.js';
import { assessmentDifferences } from '../domain/reviewedAssessment.js';
import { validateNoProtectedInference } from '../engines/policyEngine.js';
import { completedReviewFor } from './assessmentReview.js';
import { BLIND_REVIEW_STATUS } from './shadowModeCommon.js';

/** The reviewer's words, bounded. Long enough to carry a thought, short of an essay. */
const MAX_REASON_CHARS = 2000;
const MAX_EVIDENCE_REFS = 40;

/**
 * The experience band this interview was pitched at. From the plan where the
 * planner recorded one, otherwise the role's own band, otherwise blank —
 * and blank is a real key, not a missing one: it groups the interviews nobody
 * banded with each other rather than with any band in particular.
 */
function bandOf(planJson: string | null | undefined, roleBand: string | null | undefined): string {
  const plan = parseJson<InterviewPlan | null>(planJson ?? '', null);
  const fromPlan = typeof plan?.band === 'string' ? plan.band.trim() : '';
  if (fromPlan) return fromPlan;
  return (roleBand ?? '').trim();
}

/**
 * The reviewer's reason, or nothing.
 *
 * Run through the same output guardrail the evaluator's own text passes. A
 * reason mentioning a protected characteristic is DROPPED rather than stored:
 * it would otherwise be clustered into a theme and could end up shaping how a
 * role is scored, which is the one thing calibration must never learn. The row
 * is kept and marked, so the drop is visible rather than silent.
 */
function safeReason(reason: string): { text: string; redacted: boolean } {
  const trimmed = (reason ?? '').trim().slice(0, MAX_REASON_CHARS);
  if (!trimmed) return { text: '', redacted: false };
  const check = validateNoProtectedInference(trimmed);
  return check.allowed ? { text: trimmed, redacted: false } : { text: '', redacted: true };
}

interface CaptureContext {
  readonly tenantId: string;
  readonly assessmentId: string;
  readonly reviewId: string;
}

/**
 * Write one observation per competency for a completed review.
 *
 * Idempotent on (reviewId, competencyId), so a replayed submit or a backfill
 * rewrites the same rows rather than doubling the evidence — which would be
 * the easiest possible way to fake a systematic gap.
 */
export async function recordCalibrationObservations(ctx: CaptureContext): Promise<number> {
  try {
    return await capture(ctx);
  } catch (err) {
    logger.error({ err: String(err), ...ctx }, 'Calibration observations were not recorded for this review');
    return 0;
  }
}

async function capture(ctx: CaptureContext): Promise<number> {
  const assessment = await prisma.assessmentVersion.findUnique({
    where: { id: ctx.assessmentId },
    select: {
      id: true, scorecardId: true, resultJson: true,
      scorecard: { select: { version: true } },
      session: {
        select: {
          roleId: true,
          role: { select: { experienceBand: true, catalogRoleId: true } },
          plan: { select: { planJson: true } },
        },
      },
    },
  });
  if (!assessment) return 0;

  const review = await completedReviewFor(ctx.assessmentId);
  // Only the review the product acts on. A superseded one was replaced
  // deliberately, and teaching the model from a judgement its own author
  // withdrew would be teaching it from a retraction.
  if (!review || review.id !== ctx.reviewId) return 0;

  const result = parseJson<AssessmentResult | null>(assessment.resultJson, null);
  if (!result || !Array.isArray(result.competencies)) {
    logger.error({ ...ctx }, 'Assessment result unreadable; no calibration observations were recorded');
    return 0;
  }
  const differences = assessmentDifferences(result, review);
  if (!differences) return 0;

  const session = assessment.session;
  const roleId = session.roleId;
  const roleKey = roleKeyOf({ catalogRoleId: session.role?.catalogRoleId ?? null, roleId });
  const band = bandOf(session.plan?.planJson, session.role?.experienceBand);
  const blindReview = await wasBlind(ctx.assessmentId, review.reviewerId);
  const byId = new Map(result.competencies.map((c) => [c.id, c]));
  const observedAt = review.completedAt ? new Date(review.completedAt) : new Date();

  let written = 0;
  for (const difference of differences.competencies) {
    const score = byId.get(difference.competencyId);
    const aiLevel = difference.aiLevel;
    const humanLevel = difference.humanLevel;
    const delta = aiLevel !== null && humanLevel !== null ? humanLevel - aiLevel : null;
    const reason = safeReason(difference.reason);
    const evidenceTurnIds = (score?.evidence ?? [])
      .map((e) => e.turnId).filter((id): id is string => typeof id === 'string').slice(0, MAX_EVIDENCE_REFS);

    const data = {
      tenantId: ctx.tenantId,
      roleId,
      roleKey,
      band,
      competencyKey: competencyKeyOf(difference.competencyName),
      scorecardId: assessment.scorecardId,
      scorecardVersion: assessment.scorecard?.version ?? 0,
      assessmentId: ctx.assessmentId,
      reviewerId: review.reviewerId,
      aiLevel,
      humanLevel,
      delta,
      magnitude: magnitudeOf(delta),
      verdictAi: differences.disposition.ai,
      verdictHuman: differences.disposition.human,
      verdictAgreed: differences.disposition.agreed,
      reasonText: reason.text,
      reasonRedacted: reason.redacted,
      blindReview,
      aiConfidence: score?.confidence ?? 0,
      notEnoughEvidence: score?.notEnoughEvidence === true,
      evidenceCount: score?.evidence?.length ?? 0,
      evidenceTurnIdsJson: JSON.stringify(evidenceTurnIds),
      observedAt,
    };

    await prisma.calibrationObservation.upsert({
      where: { reviewId_competencyId: { reviewId: ctx.reviewId, competencyId: difference.competencyId } },
      create: { reviewId: ctx.reviewId, competencyId: difference.competencyId, ...data },
      update: data,
    });
    written += 1;
  }
  return written;
}

/**
 * Whether this reviewer had recorded a blind verdict on this assessment before
 * reviewing it. Recorded on the observation because a judgement formed before
 * the AI's was visible is independent evidence, and one formed after it is
 * partly a reading of the AI — the distinction the whole shadow-mode harness
 * exists to preserve, and it must survive into what the model learns.
 */
async function wasBlind(assessmentId: string, reviewerId: string): Promise<boolean> {
  const blind = await prisma.humanReview.findFirst({
    where: { assessmentId, reviewerId, status: BLIND_REVIEW_STATUS },
    select: { id: true },
  });
  return blind !== null;
}

/**
 * The approved scorecard's competencies, for callers that need weights and the
 * pass threshold. Null when it cannot be read, and the caller then does less
 * rather than assuming a default rubric.
 */
export async function profileForScorecard(scorecardId: string): Promise<RoleSuccessProfile | null> {
  const row = await prisma.roleScorecardVersion.findUnique({
    where: { id: scorecardId }, select: { profileJson: true },
  });
  if (!row) return null;
  const profile = parseJsonOptional<RoleSuccessProfile | null>(
    row.profileJson, null, { model: 'RoleScorecardVersion', id: scorecardId, field: 'profileJson' },
  );
  return profile && Array.isArray(profile.competencies) ? profile : null;
}
