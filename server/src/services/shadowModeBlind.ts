import { prisma, parseJsonStrict } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { assertCanAccessAssessment, ranTheInterview } from './access.js';
import type { AuthClaims } from './auth.js';
import type { AssessmentResult, RoleSuccessProfile } from '../domain/types.js';
import { BLIND_BYPASS_ACTION, BLIND_REVIEW_STATUS, type Disposition } from './shadowModeCommon.js';
import { blindReviewRequiredForTenant } from './candidateFeedbackPolicy.js';
import { logAudit } from './audit.js';
import { personaNameOf } from '../domain/persona.js';

// ---------------------------------------------------------------------------
// Blind view — the assessment with every AI conclusion withheld
// ---------------------------------------------------------------------------

export interface BlindEvidenceSpan {
  readonly turnId: string;
  readonly quote: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface BlindCompetency {
  readonly id: string;
  readonly name: string;
  readonly definition: string;
  readonly category: string;
  readonly requiredLevel: number;
  readonly indicators: readonly string[];
  readonly evidence: readonly BlindEvidenceSpan[];
}

export interface BlindTurn {
  readonly index: number;
  readonly speaker: string;
  readonly text: string;
  readonly startMs: number;
  readonly competencyId: string;
}

export interface BlindAssessmentView {
  readonly assessmentId: string;
  readonly sessionId: string;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
  readonly session: {
    readonly interviewer: string | null;
    readonly startedAt: Date | null;
    readonly completedAt: Date | null;
    readonly durationMinutes: number;
  };
  readonly competencies: readonly BlindCompetency[];
  readonly transcript: readonly BlindTurn[];
  readonly levelScale: Readonly<Record<string, string>>;
  readonly withheld: readonly string[];
  readonly blindVerdictRecorded: boolean;
  readonly instructions: string;
}

/**
 * The rubric anchors shown to the blind reviewer. These are the SAME anchors
 * given to the LLM grader in engines/evaluator.ts — comparing two raters who
 * were handed different scales would measure the scales, not the raters.
 */
const LEVEL_SCALE: Readonly<Record<string, string>> = {
  '1': 'no meaningful demonstration',
  '2': 'aware, shallow or second-hand',
  '3': 'solid working demonstration',
  '4': 'strong, owned outcomes with reasoning',
  '5': 'expert; drove outcomes others depend on, with trade-offs and measurement',
};

const WITHHELD_FIELDS: readonly string[] = [
  'recommendation',
  'overallScore',
  'confidence',
  'evidenceCoverage',
  'competency levels',
  'competency rationales',
  'notEnoughEvidence flags',
  'strengths',
  'concerns',
  'contradictions',
  'openQuestions',
  'limitations',
  'summary',
];

/**
 * Fetch an assessment as the blind reviewer must see it.
 *
 * Kept visible: the transcript, the evidence quotes the evaluator worked from,
 * and the competency definitions from the APPROVED SCORECARD. Competency
 * metadata is read from the scorecard rather than from the assessment because
 * the scorecard is the neutral rubric — it describes the job, not this
 * candidate — whereas anything the evaluator wrote is a conclusion.
 *
 * Withheld: everything in WITHHELD_FIELDS. Turn.metaJson is dropped wholesale
 * because it carries live-director signals (answer-quality scores, coverage
 * state) that would leak the machine's opinion through the side door.
 */
export async function getBlindView(
  auth: AuthClaims,
  assessmentId: string,
): Promise<BlindAssessmentView> {
  // The reviewer is always the caller. Passing a separate reviewerId alongside
  // the tenant let a caller read or file against another user's identity.
  const reviewerId = auth.userId;
  const assessment = await loadAssessment(auth, assessmentId);
  // A blind view built from {} hands the reviewer no evidence and no rubric,
  // and the verdict they file is then treated as a real sample point.
  const result = parseJsonStrict<AssessmentResult>(assessment.resultJson, { model: 'AssessmentVersion', id: assessment.id, field: 'resultJson' });
  const profile = parseJsonStrict<RoleSuccessProfile>(assessment.scorecard.profileJson, { model: 'RoleScorecardVersion', id: assessment.scorecard.id, field: 'profileJson' });

  const turns = await prisma.turn.findMany({
    where: { sessionId: assessment.sessionId },
    orderBy: { index: 'asc' },
  });

  // Evidence spans are the reviewer's raw material, so they stay — but they are
  // pulled off the scored competencies with the scores themselves left behind.
  const evidenceByCompetency = new Map<string, readonly BlindEvidenceSpan[]>();
  for (const scored of result.competencies ?? []) {
    evidenceByCompetency.set(
      scored.id,
      (scored.evidence ?? []).map((e) => ({ turnId: e.turnId, quote: e.quote, startMs: e.startMs, endMs: e.endMs })),
    );
  }

  const scoredCompetencies = (profile.competencies ?? []).filter(
    (c) => c.classification !== 'non_scoring' && c.weight > 0,
  );

  const competencies: BlindCompetency[] = scoredCompetencies.map((c) => ({
    id: c.id,
    name: c.name,
    definition: c.definition,
    category: c.category,
    requiredLevel: c.requiredLevel,
    indicators: c.indicators ?? [],
    evidence: evidenceByCompetency.get(c.id) ?? [],
  }));

  const existing = await findBlindReview(assessmentId, reviewerId);

  return {
    assessmentId: assessment.id,
    sessionId: assessment.sessionId,
    candidate: { id: assessment.session.candidateId, name: assessment.session.candidate.fullName },
    role: { id: assessment.session.roleId, title: assessment.session.role.title },
    // Who interviewed, when and how long: what the review page's header says
    // above the transcript. Facts about the conversation, not about the score.
    session: {
      interviewer: personaNameOf(assessment.session.personaJson, assessment.session.id),
      startedAt: assessment.session.startedAt,
      completedAt: assessment.session.completedAt,
      durationMinutes: assessment.session.durationMinutes,
    },
    competencies,
    transcript: turns.map((t) => ({
      index: t.index,
      speaker: t.speaker,
      text: t.text,
      // Time into the interview: the review page stamps each turn with it.
      // A clock is not a conclusion, so it is not withheld.
      startMs: t.startMs,
      competencyId: t.competencyId,
    })),
    levelScale: LEVEL_SCALE,
    withheld: WITHHELD_FIELDS,
    blindVerdictRecorded: existing !== null,
    instructions:
      'Record your own disposition and per-competency levels from the transcript and evidence above. ' +
      "The AI's recommendation, scores and summary are withheld until your verdict is saved. " +
      'Judge the evidence, not the fluency of the answers, and leave a competency unscored if the ' +
      'transcript does not support a judgement.',
  };
}

// ---------------------------------------------------------------------------
// Recording the blind verdict
// ---------------------------------------------------------------------------

export interface BlindCompetencyVerdict {
  readonly competencyId: string;
  readonly level: number;
  readonly reason?: string;
}

export interface BlindVerdictInput {
  readonly disposition: Disposition;
  readonly reason: string;
  readonly comments?: string;
  readonly competencyLevels?: readonly BlindCompetencyVerdict[];
}

/**
 * Persist an independent verdict using the existing HumanReview model.
 *
 * Storage mapping (no schema change — see BLIND_REVIEW_STATUS):
 *   status        = 'BLIND'      provenance marker: recorded before reveal
 *   disposition   = human's own call
 *   reason        = human's rationale
 *   overridesJson = [{competencyId, from, to, reason}]  — the shape the existing
 *                   review route already stores and reads. `from` is null
 *                   because there was nothing to override: the reviewer had not
 *                   seen a machine level to move away from.
 *
 * One verdict per reviewer per assessment. A reviewer who could resubmit could
 * quietly rewrite their blind call after the reveal, which would silently
 * destroy the independence the whole harness depends on.
 */
export async function recordBlindVerdict(
  auth: AuthClaims,
  assessmentId: string,
  input: BlindVerdictInput,
): Promise<{ reviewId: string; recordedAt: Date; selfReview: boolean }> {
  const reviewerId = auth.userId;
  const assessment = await loadAssessment(auth, assessmentId);

  const existing = await findBlindReview(assessment.id, reviewerId);
  if (existing) {
    throw new HttpError(
      409,
      'A blind verdict has already been recorded for this assessment by this reviewer and cannot be replaced.',
    );
  }

  const overrides = (input.competencyLevels ?? []).map((c) => ({
    competencyId: c.competencyId,
    from: null,
    to: c.level,
    reason: c.reason ?? 'Independent blind assessment.',
  }));

  const selfReview = await ranTheInterview(reviewerId, assessment.sessionId);

  const recordedAt = new Date();
  const review = await prisma.humanReview.create({
    data: {
      assessmentId: assessment.id,
      reviewerId,
      status: BLIND_REVIEW_STATUS,
      disposition: input.disposition,
      reason: input.reason,
      comments: annotateSelfReview(input.comments ?? '', selfReview),
      overridesJson: JSON.stringify(overrides),
      completedAt: recordedAt,
    },
  });

  return { reviewId: review.id, recordedAt, selfReview };
}

/**
 * Marker written into HumanReview.comments when the reviewer drove the
 * interview they are now judging.
 */
export const SELF_REVIEW_NOTE =
  'SEPARATION OF DUTIES: this verdict was recorded by the same user who conducted the interview, '
  + 'so it is not an independent review.';

/**
 * Record, rather than block, a reviewer judging their own interview.
 *
 * Independence is what makes the human review meaningful under GDPR Art. 22 and
 * NYC LL144, so self-review genuinely weakens the compliance position. But a
 * hard block fails badly in the real case: a five-person recruiting team often
 * has nobody else available, and a 403 at that moment does not produce an
 * independent reviewer — it produces someone borrowing the admin account, which
 * destroys the audit trail as well as the independence. Writing it into the
 * review record and the audit log keeps the missing independence VISIBLE in the
 * compliance artefact instead of invisible outside it.
 */
function annotateSelfReview(comments: string, selfReview: boolean): string {
  if (!selfReview) return comments;
  return comments ? `${comments}\n\n${SELF_REVIEW_NOTE}` : SELF_REVIEW_NOTE;
}

/**
 * The reveal gate. Callers must prove a blind verdict exists before the AI
 * output is handed over; without this the "blind" in blind verdict is a
 * convention rather than a control.
 */
export async function assertBlindVerdictRecorded(assessmentId: string, reviewerId: string): Promise<void> {
  const existing = await findBlindReview(assessmentId, reviewerId);
  if (!existing) {
    throw new HttpError(
      409,
      'Record your independent verdict first. The AI recommendation and scores are withheld until then.',
    );
  }
}

/**
 * Has this user already earned unblinded access to this assessment — either by
 * recording their independent verdict, or by explicitly bypassing with a reason?
 *
 * The bypass is stored as an audit event rather than a new table: the fact is
 * inherently an audit fact, and keeping it there means a bypass cannot be
 * removed without removing the audit trail that records it.
 */
export async function hasUnblindedAccess(assessmentId: string, reviewerId: string): Promise<boolean> {
  return (await unblindedAssessmentIds([assessmentId], reviewerId)).has(assessmentId);
}

/** hasUnblindedAccess for many assessments in two queries, for list views. */
async function unblindedAssessmentIds(assessmentIds: readonly string[], reviewerId: string): Promise<ReadonlySet<string>> {
  if (assessmentIds.length === 0) return new Set();
  const [verdicts, bypasses] = await Promise.all([
    prisma.humanReview.findMany({
      where: { assessmentId: { in: [...assessmentIds] }, reviewerId, status: BLIND_REVIEW_STATUS },
      select: { assessmentId: true },
    }),
    prisma.auditEvent.findMany({
      where: { entityId: { in: [...assessmentIds] }, actorId: reviewerId, action: BLIND_BYPASS_ACTION },
      select: { entityId: true },
    }),
  ]);
  return new Set([...verdicts.map((v) => v.assessmentId), ...bypasses.map((b) => b.entityId)]);
}

/**
 * The assessments, among `assessmentIds`, whose AI recommendation and scores
 * this caller may be shown now. The same rule assertUnblindedReadAllowed
 * enforces, answered for a whole list at once so the interview list, the
 * interview page and the pipeline summary cannot hand a reviewer what the
 * assessment page withholds. Records nothing: the unblinded read is recorded
 * where the AI output is actually opened.
 */
export async function aiConclusionVisible(o: {
  assessmentIds: readonly string[];
  userId: string;
  canReview: boolean;
  tenantId: string;
}): Promise<ReadonlySet<string>> {
  if (!o.canReview || !await blindReviewRequiredForTenant(o.tenantId)) return new Set(o.assessmentIds);
  return unblindedAssessmentIds(o.assessmentIds, o.userId);
}

/**
 * Gate unblinded assessment reads for people who are going to judge.
 *
 * Applies ONLY to holders of `assessment:review`. Someone with plain
 * `assessment:read` — typically the recruiter who ran the interview and needs
 * the outcome — is not the decision-maker being protected from anchoring here,
 * and gating them would lock them out permanently since they cannot file a
 * verdict at all.
 *
 * A reviewer who has recorded a verdict, or consciously bypassed, keeps access
 * for good: the anchoring risk exists once, before they form a view.
 *
 * And only when the organisation asks for it (`requireBlindReview`). The owner
 * decided hiring teams see the assessment straight away: the blind review stays
 * one click away on the assessment page for anyone who wants their own read
 * first, and shadow-mode metrics count whatever blind verdicts are filed, but
 * nobody is locked out of a finished assessment by default.
 */
export const BLIND_REVIEW_REQUIRED = 'blind_review_required';

/**
 * Written the first time a reviewer opens an assessment without having judged
 * blind. The gate is optional now, so this is what is left of the artefact:
 * the compliance record still shows, per reviewer and per assessment, whether
 * the human judgement came before the machine's or after it.
 */
export const UNBLINDED_READ_ACTION = 'assessment.ai_viewed_without_blind_verdict';

/** Once per reviewer per assessment: a page they refresh is one read, not ten. */
async function recordUnblindedRead(o: { assessmentId: string; userId: string; tenantId: string }): Promise<void> {
  const already = await prisma.auditEvent.count({
    where: { entityId: o.assessmentId, actorId: o.userId, action: UNBLINDED_READ_ACTION },
  });
  if (already > 0) return;
  await logAudit({
    tenantId: o.tenantId, actorId: o.userId, actorType: 'user', action: UNBLINDED_READ_ACTION,
    entityType: 'AssessmentVersion', entityId: o.assessmentId,
    after: { blindVerdictFirst: false, requiredByPolicy: false },
  });
}

export async function assertUnblindedReadAllowed(o: {
  assessmentId: string;
  userId: string;
  canReview: boolean;
  tenantId: string;
}): Promise<void> {
  if (!o.canReview) return;
  if (!await blindReviewRequiredForTenant(o.tenantId)) {
    if (!await hasUnblindedAccess(o.assessmentId, o.userId)) await recordUnblindedRead(o);
    return;
  }
  if (await hasUnblindedAccess(o.assessmentId, o.userId)) return;
  throw new HttpError(
    409,
    'Record your independent verdict first, or state a reason for skipping it. '
    + 'The AI recommendation and scores stay hidden until then so your judgement is your own.',
    BLIND_REVIEW_REQUIRED,
  );
}

async function findBlindReview(assessmentId: string, reviewerId: string) {
  return prisma.humanReview.findFirst({
    where: { assessmentId, reviewerId, status: BLIND_REVIEW_STATUS },
  });
}

/**
 * Load an assessment the caller is entitled to see.
 *
 * Takes AuthClaims rather than a tenantId because a tenant match was never
 * authorisation here: shadow mode hands over the full transcript and every
 * evidence quote, so a tenant-only check let any authenticated user read any
 * candidate's interview. Object scope is delegated to services/access.ts so
 * there is one definition of who may touch an assessment; the second read
 * exists only to pull the scorecard relation that access.ts does not include.
 */
async function loadAssessment(auth: AuthClaims, id: string) {
  await assertCanAccessAssessment(auth, id);
  const assessment = await prisma.assessmentVersion.findUnique({
    where: { id },
    include: { scorecard: true, session: { include: { candidate: true, role: true } } },
  });
  if (!assessment) throw new HttpError(404, 'Assessment not found');
  return assessment;
}
