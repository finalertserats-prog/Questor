import { prisma, parseJsonOptional } from '../db.js';
import {
  firstUnreviewed, reviewRequirementFor,
  type ConductedInterview, type ReviewRequirement, type UnreviewedInterview,
} from '../domain/humanReviewRule.js';

/**
 * Reads the candidate's AI interviews and answers the question the promise
 * turns on: has a person reviewed them?
 *
 * The rule itself is pure (domain/humanReviewRule.ts). This is the part that
 * knows where the facts live: the consent flag inside InterviewSession's
 * consentJson, the assessment a reviewer would open, whether a retake replaced
 * the attempt, and whether an active completed HumanReview claims the
 * assessment.
 *
 * Every query is scoped by tenant. A gate that could be satisfied by another
 * organisation's review would be worse than no gate, because it would look
 * like one in the audit trail.
 */

/** What we call the active, completed, unsuperseded review of an assessment. */
const ACTIVE_COMPLETED = { status: 'COMPLETED', supersededAt: null } as const;

function consentFlag(session: { id: string; consentJson: string }): boolean | undefined {
  const consent = parseJsonOptional<Record<string, unknown>>(
    session.consentJson, {}, { model: 'InterviewSession', id: session.id, field: 'consentJson' },
  );
  const flag = consent.humanReviewRequired;
  // Anything other than a boolean is treated as "never recorded". A consent
  // record whose flag is a string is not a promise we can prove was made, and
  // guessing at one is how a candidate gets stuck in a pipeline.
  return typeof flag === 'boolean' ? flag : undefined;
}

/**
 * The assessment a reviewer opens for a session: the newest one. A session with
 * several versions is reviewed at its latest, which is what the review page
 * loads and what the pipeline acts on.
 */
function latestAssessmentId(assessments: readonly { id: string }[]): string | null {
  return assessments.length > 0 ? assessments[0].id : null;
}

interface SessionRow {
  readonly id: string;
  readonly state: string;
  readonly consentJson: string;
  readonly assessments: readonly { readonly id: string }[];
  readonly retakes: readonly { readonly id: string }[];
}

async function interviewsFor(where: { tenantId: string; candidateId: string; roleId: string }): Promise<ConductedInterview[]> {
  const sessions = await prisma.interviewSession.findMany({
    where,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, state: true, consentJson: true,
      assessments: { orderBy: [{ version: 'desc' }, { createdAt: 'desc' }], take: 1, select: { id: true } },
      retakes: { take: 1, select: { id: true } },
    },
  });
  return withReviewState(sessions);
}

async function withReviewState(sessions: readonly SessionRow[]): Promise<ConductedInterview[]> {
  const assessmentIds = sessions.map((s) => latestAssessmentId(s.assessments)).filter((id): id is string => id !== null);
  // One query for the whole history rather than one per session: the answer is
  // read on every decision, and a candidate with four attempts should not cost
  // four round trips to find out nobody read the first.
  const reviewed = assessmentIds.length === 0 ? [] : await prisma.humanReview.findMany({
    where: { assessmentId: { in: assessmentIds }, activeForAssessmentId: { not: null }, ...ACTIVE_COMPLETED },
    select: { assessmentId: true },
  });
  const done = new Set(reviewed.map((r) => r.assessmentId));
  return sessions.map((session) => {
    const assessmentId = latestAssessmentId(session.assessments);
    return {
      sessionId: session.id,
      state: session.state,
      humanReviewRequired: consentFlag(session),
      assessmentId,
      retaken: session.retakes.length > 0,
      reviewed: assessmentId !== null && done.has(assessmentId),
    };
  });
}

/**
 * What the audit trail records about the promise, whichever way the check
 * came out. "Checked and not required" belongs in the record as much as
 * "checked and satisfied": without it, an exempt candidate and an unreviewed
 * one look identical a year later, which is the state this whole change exists
 * to end.
 */
export type HumanReviewRecord =
  | { readonly required: false; readonly because: string }
  | { readonly required: true; readonly satisfiedBy: readonly string[] }
  | { readonly required: true; readonly missingFor: string };

export interface HumanReviewCheck {
  /** The first interview still owing a review, or null when the promise is kept. */
  readonly missing: UnreviewedInterview | null;
  readonly record: HumanReviewRecord;
}

/**
 * Has a person reviewed this candidate's AI interviews for this role?
 *
 * A candidate with no AI interview at all answers "nothing to enforce", which
 * is why ordinary pipeline work is untouched by this gate.
 */
export async function humanReviewCheck(
  o: { readonly tenantId: string; readonly candidateId: string; readonly roleId: string | null },
): Promise<HumanReviewCheck> {
  if (!o.roleId) return { missing: null, record: { required: false, because: 'no_role' } };
  const interviews = await interviewsFor({ tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId });
  if (interviews.length === 0) return { missing: null, record: { required: false, because: 'no_ai_interview' } };

  const missing = firstUnreviewed(interviews);
  if (missing) return { missing, record: { required: true, missingFor: missing.assessmentId } };

  const requirements = interviews.map(reviewRequirementFor);
  const satisfiedBy = requirements.filter((r) => r.required).map((r) => r.assessmentId);
  if (satisfiedBy.length > 0) return { missing: null, record: { required: true, satisfiedBy } };
  // Every interview was exempt. The last one's reason is the one worth keeping:
  // it is the attempt the decision is actually about.
  const last = requirements[requirements.length - 1] as { because: string };
  return { missing: null, record: { required: false, because: last.because } };
}

/**
 * The same question about one assessment, for the paths that already know
 * which interview they are acting on (the ATS export).
 */
export async function assessmentReviewRequirement(
  o: { readonly tenantId: string; readonly assessmentId: string },
): Promise<ReviewRequirement> {
  const assessment = await prisma.assessmentVersion.findFirst({
    where: { id: o.assessmentId, session: { tenantId: o.tenantId } },
    select: {
      id: true,
      session: {
        select: {
          id: true, state: true, consentJson: true,
          retakes: { take: 1, select: { id: true } },
        },
      },
    },
  });
  // Out of scope reads as "nothing to enforce": the caller's own object-scope
  // check is what refuses, and answering here would leak whether it exists.
  if (!assessment) return { required: false, because: 'no_assessment' };
  const review = await prisma.humanReview.findFirst({
    where: { assessmentId: assessment.id, activeForAssessmentId: { not: null }, ...ACTIVE_COMPLETED },
    select: { id: true },
  });
  return reviewRequirementFor({
    sessionId: assessment.session.id,
    state: assessment.session.state,
    humanReviewRequired: consentFlag(assessment.session),
    assessmentId: assessment.id,
    retaken: assessment.session.retakes.length > 0,
    reviewed: review !== null,
  });
}

