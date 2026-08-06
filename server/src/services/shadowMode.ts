import { prisma, parseJson } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { assertCanAccessAssessment, ranTheInterview } from './access.js';
import type { AuthClaims } from './auth.js';
import type { AssessmentResult, RoleSuccessProfile } from '../domain/types.js';

// Shadow mode: a scoring-validity harness AND a compliance safeguard.
//
// WHY THIS EXISTS
// Questor's score is advisory. That framing is what keeps the employer outside
// GDPR Art. 22 ("decision based solely on automated processing") and NYC LL144's
// automated-employment-decision rules — but ONLY while the human review is
// genuinely meaningful. A reviewer who opens the AI's PROCEED/CONSIDER call and
// then agrees with it is anchoring, not reviewing; regulators read that as a
// rubber stamp and treat the pipeline as fully automated.
//
// Shadow mode inverts the order: the reviewer records their own verdict from the
// evidence and transcript BEFORE the AI's conclusions are shown. That single
// change buys two things at once:
//   1. Validity  — the blind human verdict is an independent measurement, so
//                  human/AI agreement actually means something. Agreement
//                  measured after the human saw the AI's answer measures
//                  anchoring, not accuracy.
//   2. Compliance — a documented independent-first review is evidence that human
//                  oversight was real.
//
// WHAT THIS FILE DOES NOT DO
// It MEASURES agreement. It does not establish validity, and no function here
// should ever return a number that flatters the system. When there is no data,
// say so.

/** Terminal dispositions shared by the AI recommendation and the human verdict. */
export const DISPOSITIONS = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * HumanReview.status marker for a verdict recorded BEFORE the AI output was
 * revealed. The schema types `status` as a free string (documented as
 * PENDING | COMPLETED), so this extends the vocabulary without a migration.
 * Only rows carrying this marker are eligible for the agreement statistics —
 * a verdict filed through the normal review endpoint was made with the AI's
 * recommendation on screen and is therefore contaminated for this purpose.
 */
export const BLIND_REVIEW_STATUS = 'BLIND';

/**
 * The launch gate recorded in docs/BUILD_STATUS.md. It is quoted here, not
 * chosen here — this harness does not get to set its own passing grade.
 */
export const AGREEMENT_GATE = 0.75;

/**
 * Below this many paired observations the normal approximation used for the
 * kappa confidence interval is not trustworthy, so no conclusion is reported.
 * This is a conventional rule of thumb about the large-sample approximation —
 * it is NOT a power calculation and NOT a validated sample size for this tool.
 */
export const MINIMUM_N = 30;

// ---------------------------------------------------------------------------
// Cohen's kappa
// ---------------------------------------------------------------------------

export interface KappaResult {
  /** Number of paired observations. */
  readonly n: number;
  /** Observed proportion of exact agreement (p_o). Null when n = 0. */
  readonly rawAgreement: number | null;
  /** Agreement expected by chance from the two raters' marginals (p_e). */
  readonly expectedAgreement: number | null;
  /** (p_o - p_e) / (1 - p_e). Null when undefined — see `undefinedReason`. */
  readonly kappa: number | null;
  /** Large-sample standard error of kappa. Null whenever kappa is null. */
  readonly standardError: number | null;
  /** 95% CI for kappa, [lower, upper]. Null whenever kappa is null. */
  readonly ci95: readonly [number, number] | null;
  /** Human-readable reason kappa could not be computed, else null. */
  readonly undefinedReason: string | null;
}

const EMPTY_KAPPA: KappaResult = {
  n: 0,
  rawAgreement: null,
  expectedAgreement: null,
  kappa: null,
  standardError: null,
  ci95: null,
  undefinedReason: 'No paired observations — nothing has been measured yet.',
};

/**
 * Cohen's kappa for two raters over a shared nominal label set.
 *
 * WHY NOT RAW AGREEMENT ALONE: in screening, one class dominates. If 90% of
 * candidates are CONSIDER, a rater that says CONSIDER every single time scores
 * 90% raw agreement while carrying zero information. Kappa subtracts the
 * agreement the two raters' own marginal rates would produce by chance.
 *
 * Implemented here rather than pulled from a package: it is ~20 lines, and a
 * statistic that gates a hiring launch should be auditable in-repo.
 */
export function computeCohenKappa(pairs: ReadonlyArray<readonly [string, string]>): KappaResult {
  const n = pairs.length;
  if (n === 0) return EMPTY_KAPPA;

  let observedMatches = 0;
  const marginalA = new Map<string, number>();
  const marginalB = new Map<string, number>();
  for (const [a, b] of pairs) {
    if (a === b) observedMatches++;
    marginalA.set(a, (marginalA.get(a) ?? 0) + 1);
    marginalB.set(b, (marginalB.get(b) ?? 0) + 1);
  }

  const po = observedMatches / n;

  // p_e = sum over labels of P(rater A picks L) * P(rater B picks L).
  let pe = 0;
  for (const [label, countA] of marginalA) {
    const countB = marginalB.get(label) ?? 0;
    pe += (countA / n) * (countB / n);
  }

  // Degenerate case: both raters used one and the same single category
  // throughout, so chance alone predicts perfect agreement and kappa is 0/0.
  // Returning 1.0 here would be the single most flattering lie this file could
  // tell, so it returns null and explains itself instead.
  const denominator = 1 - pe;
  if (denominator <= 1e-12) {
    return {
      n,
      rawAgreement: po,
      expectedAgreement: pe,
      kappa: null,
      standardError: null,
      ci95: null,
      undefinedReason:
        'Chance agreement is 1.0 because every observation used the same single category. ' +
        'Kappa is undefined here, and the high raw agreement carries no information.',
    };
  }

  const kappa = (po - pe) / denominator;
  // Large-sample SE (Fleiss et al.): sqrt( p_o(1-p_o) / (n (1-p_e)^2) ).
  const standardError = Math.sqrt((po * (1 - po)) / (n * denominator * denominator));
  const margin = 1.96 * standardError;

  return {
    n,
    rawAgreement: round(po),
    expectedAgreement: round(pe),
    kappa: round(kappa),
    standardError: round(standardError),
    ci95: [round(kappa - margin), round(kappa + margin)],
    undefinedReason: null,
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

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
  readonly competencyId: string;
}

export interface BlindAssessmentView {
  readonly assessmentId: string;
  readonly sessionId: string;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
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
  const result = parseJson<AssessmentResult>(assessment.resultJson, {} as AssessmentResult);
  const profile = parseJson<RoleSuccessProfile>(assessment.scorecard.profileJson, {} as RoleSuccessProfile);

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
    competencies,
    transcript: turns.map((t) => ({
      index: t.index,
      speaker: t.speaker,
      text: t.text,
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

/** Audit action recording that a reviewer opened an assessment without blinding. */
export const BLIND_BYPASS_ACTION = 'review.blind_bypassed';

/**
 * Has this user already earned unblinded access to this assessment — either by
 * recording their independent verdict, or by explicitly bypassing with a reason?
 *
 * The bypass is stored as an audit event rather than a new table: the fact is
 * inherently an audit fact, and keeping it there means a bypass cannot be
 * removed without removing the audit trail that records it.
 */
export async function hasUnblindedAccess(assessmentId: string, reviewerId: string): Promise<boolean> {
  const [verdict, bypass] = await Promise.all([
    findBlindReview(assessmentId, reviewerId),
    prisma.auditEvent.count({
      where: { entityId: assessmentId, actorId: reviewerId, action: BLIND_BYPASS_ACTION },
    }),
  ]);
  return Boolean(verdict) || bypass > 0;
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
 */
export async function assertUnblindedReadAllowed(o: {
  assessmentId: string;
  userId: string;
  canReview: boolean;
}): Promise<void> {
  if (!o.canReview) return;
  if (await hasUnblindedAccess(o.assessmentId, o.userId)) return;
  throw new HttpError(
    409,
    'Record your independent verdict first, or state a reason for skipping it. '
    + 'The AI recommendation and scores stay hidden until then so your judgement is your own.',
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

// ---------------------------------------------------------------------------
// Agreement metrics
// ---------------------------------------------------------------------------

/** One blind-vs-AI observation, flattened so the statistics are pure functions. */
export interface ShadowObservation {
  readonly assessmentId: string;
  readonly humanDisposition: string;
  readonly aiRecommendation: string;
  readonly competencies: ReadonlyArray<{
    readonly competencyId: string;
    readonly competencyName: string;
    readonly humanLevel: number;
    readonly aiLevel: number;
  }>;
}

export interface CompetencyBreakdown {
  readonly competencyId: string;
  readonly competencyName: string;
  readonly n: number;
  readonly exactAgreement: number;
  readonly withinOneLevel: number;
  readonly meanSignedError: number;
}

export interface AgreementReport {
  readonly generatedAt: string;
  readonly sampleSize: {
    readonly blindVerdicts: number;
    readonly assessmentsTotal: number;
    readonly coverage: number;
  };
  readonly sufficiency: {
    readonly sufficient: boolean;
    readonly minimumN: number;
    readonly statement: string;
  };
  readonly disposition: KappaResult & {
    readonly confusionMatrix: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly humanDistribution: Readonly<Record<string, number>>;
    readonly aiDistribution: Readonly<Record<string, number>>;
  };
  readonly competencyLevel: KappaResult & {
    readonly exactAgreement: number | null;
    readonly withinOneLevel: number | null;
    readonly meanSignedError: number | null;
    readonly byCompetency: readonly CompetencyBreakdown[];
  };
  readonly gate: {
    readonly source: string;
    readonly threshold: number;
    readonly statistic: string;
    readonly met: boolean | null;
    readonly statement: string;
  };
  readonly caveats: readonly string[];
  /**
   * How often blinding was skipped. Present only on the DB-backed report;
   * `computeAgreementReport` is a pure function over observations and has no
   * view of bypasses.
   */
  readonly blindingBypassed?: {
    readonly events: number;
    readonly assessments: number;
    readonly note: string;
  };
}

/**
 * Compute the agreement report from already-gathered observations.
 * Pure and DB-free so the statistics can be tested directly.
 */
export function computeAgreementReport(
  observations: readonly ShadowObservation[],
  assessmentsTotal: number,
): AgreementReport {
  const dispositionPairs: Array<readonly [string, string]> = observations.map(
    (o) => [o.humanDisposition, o.aiRecommendation] as const,
  );
  const dispositionKappa = computeCohenKappa(dispositionPairs);

  const levelPairs: Array<readonly [string, string]> = [];
  for (const o of observations) {
    for (const c of o.competencies) levelPairs.push([String(c.humanLevel), String(c.aiLevel)] as const);
  }
  const levelKappa = computeCohenKappa(levelPairs);

  const n = observations.length;
  const sufficient = n >= MINIMUM_N;

  // The gate is tested against the LOWER bound of the 95% CI, not the point
  // estimate. A point estimate of 0.78 with a CI of [0.41, 1.00] has not
  // demonstrated 0.75 agreement; it is consistent with 0.41.
  const lowerBound = dispositionKappa.ci95?.[0] ?? null;
  const gateMet = sufficient && lowerBound !== null ? lowerBound >= AGREEMENT_GATE : null;

  const caveats: string[] = [
    'This harness MEASURES agreement between blind human reviewers and the AI. It does not establish that ' +
      'either the AI or the reviewers are correct, and agreement is not the same thing as validity.',
    'Only verdicts recorded before the AI output was revealed are counted. Agreement measured after a ' +
      'reviewer has seen the AI recommendation reflects anchoring, not independent judgement.',
    'Raw agreement is reported alongside kappa because raw agreement alone is inflated whenever one ' +
      'disposition dominates the sample, which it usually does in screening.',
    'Neither statistic detects shared bias: if reviewers and the model are wrong in the same direction, ' +
      'agreement will be high. Adverse-impact analysis is a separate, unbuilt check.',
  ];
  if (n > 0 && !sufficient) {
    caveats.push(
      `Sample size n=${n} is below the ${MINIMUM_N}-observation minimum for the confidence interval to be ` +
        'meaningful. Treat every number in this report as provisional.',
    );
  }
  if (dispositionKappa.undefinedReason) caveats.push(`Disposition kappa: ${dispositionKappa.undefinedReason}`);
  if (levelKappa.undefinedReason && levelPairs.length > 0) {
    caveats.push(`Competency-level kappa: ${levelKappa.undefinedReason}`);
  }

  return {
    generatedAt: new Date().toISOString(),
    sampleSize: {
      blindVerdicts: n,
      assessmentsTotal,
      coverage: assessmentsTotal > 0 ? round(n / assessmentsTotal) : 0,
    },
    sufficiency: {
      sufficient,
      minimumN: MINIMUM_N,
      statement:
        n === 0
          ? 'No blind human verdicts have been recorded. No agreement has been measured and no conclusion ' +
            'about scoring validity can be drawn.'
          : sufficient
            ? `n=${n} paired verdicts. The confidence interval is reported; read the gate against its lower bound.`
            : `n=${n} paired verdicts, below the minimum of ${MINIMUM_N}. Nothing can be concluded from this sample.`,
    },
    disposition: {
      ...dispositionKappa,
      confusionMatrix: buildConfusionMatrix(dispositionPairs),
      humanDistribution: countLabels(dispositionPairs.map((p) => p[0])),
      aiDistribution: countLabels(dispositionPairs.map((p) => p[1])),
    },
    competencyLevel: {
      ...levelKappa,
      exactAgreement: levelKappa.rawAgreement,
      withinOneLevel: levelPairs.length
        ? round(levelPairs.filter(([a, b]) => Math.abs(Number(a) - Number(b)) <= 1).length / levelPairs.length)
        : null,
      meanSignedError: levelPairs.length
        ? round(levelPairs.reduce((acc, [a, b]) => acc + (Number(b) - Number(a)), 0) / levelPairs.length)
        : null,
      byCompetency: buildCompetencyBreakdown(observations),
    },
    gate: {
      source: 'docs/BUILD_STATUS.md launch gate: scoring-validity study, >=0.75 human agreement.',
      threshold: AGREEMENT_GATE,
      statistic:
        "Cohen's kappa on disposition, tested against the lower bound of its 95% CI. BUILD_STATUS.md does " +
        'not specify which statistic "0.75 human agreement" refers to; this is our stated, conservative ' +
        'reading and should be confirmed with whoever owns the gate.',
      met: gateMet,
      statement:
        gateMet === null
          ? 'NOT MET — insufficient data to evaluate the gate. The AI score must not drive decisions.'
          : gateMet
            ? `Gate condition satisfied at n=${n} (CI lower bound ${lowerBound}). This is one measurement, ` +
              'not a completed validity study, and does not by itself clear the launch gate.'
            : `NOT MET at n=${n} (CI lower bound ${lowerBound} < ${AGREEMENT_GATE}). The AI score must not ` +
              'drive decisions.',
    },
    caveats,
  };
}

function countLabels(labels: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of labels) out[l] = (out[l] ?? 0) + 1;
  return out;
}

/** Rows = human verdict, columns = AI recommendation. */
function buildConfusionMatrix(
  pairs: ReadonlyArray<readonly [string, string]>,
): Record<string, Record<string, number>> {
  const matrix: Record<string, Record<string, number>> = {};
  for (const human of DISPOSITIONS) {
    const row: Record<string, number> = {};
    for (const ai of DISPOSITIONS) row[ai] = 0;
    matrix[human] = row;
  }
  for (const [human, ai] of pairs) {
    const row = matrix[human] ?? (matrix[human] = {});
    row[ai] = (row[ai] ?? 0) + 1;
  }
  return matrix;
}

function buildCompetencyBreakdown(observations: readonly ShadowObservation[]): CompetencyBreakdown[] {
  const grouped = new Map<string, { name: string; pairs: Array<readonly [number, number]> }>();
  for (const o of observations) {
    for (const c of o.competencies) {
      const entry = grouped.get(c.competencyId) ?? { name: c.competencyName, pairs: [] };
      entry.pairs.push([c.humanLevel, c.aiLevel] as const);
      grouped.set(c.competencyId, entry);
    }
  }

  return [...grouped.entries()]
    .map(([competencyId, entry]) => {
      const n = entry.pairs.length;
      return {
        competencyId,
        competencyName: entry.name,
        n,
        exactAgreement: round(entry.pairs.filter(([h, a]) => h === a).length / n),
        withinOneLevel: round(entry.pairs.filter(([h, a]) => Math.abs(h - a) <= 1).length / n),
        // Positive => the AI scores this competency HIGHER than blind reviewers do.
        meanSignedError: round(entry.pairs.reduce((acc, [h, a]) => acc + (a - h), 0) / n),
      };
    })
    .sort((a, b) => b.n - a.n);
}

/**
 * Gather every blind verdict in the tenant and pair it with the AI's output.
 * Competency levels are paired only where BOTH raters produced a level for the
 * SAME competency: an unscored competency on either side is missing data, and
 * imputing a value there would manufacture agreement that nobody recorded.
 */
export async function getAgreementReport(tenantId: string): Promise<AgreementReport> {
  const blindReviews = await prisma.humanReview.findMany({
    where: {
      status: BLIND_REVIEW_STATUS,
      assessment: { session: { tenantId } },
    },
    include: { assessment: true },
    orderBy: { createdAt: 'asc' },
  });

  const assessmentsTotal = await prisma.assessmentVersion.count({ where: { session: { tenantId } } });

  const observations: ShadowObservation[] = [];
  const seen = new Set<string>();

  for (const review of blindReviews) {
    // One observation per assessment. Two reviewers blind-reviewing the same
    // assessment would otherwise enter the sample as two independent data
    // points about the model when they are two opinions about one interview.
    if (seen.has(review.assessmentId)) continue;
    if (!isDisposition(review.disposition)) continue;
    seen.add(review.assessmentId);

    const result = parseJson<AssessmentResult>(review.assessment.resultJson, {} as AssessmentResult);
    const aiLevels = new Map<string, { name: string; level: number }>();
    for (const c of result.competencies ?? []) {
      if (typeof c.level === 'number' && !c.notEnoughEvidence) aiLevels.set(c.id, { name: c.name, level: c.level });
    }

    const humanLevels = parseJson<Array<{ competencyId?: unknown; to?: unknown }>>(review.overridesJson, []);
    const competencies: Array<ShadowObservation['competencies'][number]> = [];
    for (const entry of humanLevels) {
      const competencyId = typeof entry.competencyId === 'string' ? entry.competencyId : null;
      const humanLevel = typeof entry.to === 'number' ? entry.to : null;
      if (competencyId === null || humanLevel === null) continue;
      const ai = aiLevels.get(competencyId);
      if (!ai) continue;
      competencies.push({ competencyId, competencyName: ai.name, humanLevel, aiLevel: ai.level });
    }

    observations.push({
      assessmentId: review.assessmentId,
      humanDisposition: review.disposition,
      aiRecommendation: review.assessment.recommendation,
      competencies,
    });
  }

  const report = computeAgreementReport(observations, assessmentsTotal);

  // Bypasses are reported alongside the agreement numbers deliberately. A team
  // that habitually skips blinding still produces a clean-looking kappa from the
  // few reviews it did blind, and the sample is no longer representative of how
  // decisions are actually made. Showing the skip count next to the statistic is
  // what stops that reading as compliance.
  const bypasses = await prisma.auditEvent.findMany({
    where: { tenantId, action: BLIND_BYPASS_ACTION },
    select: { entityId: true, actorId: true },
  });
  const bypassedAssessments = new Set(bypasses.map((b) => b.entityId)).size;

  return {
    ...report,
    blindingBypassed: {
      events: bypasses.length,
      assessments: bypassedAssessments,
      note: bypassedAssessments === 0
        ? 'No reviewer has opened an assessment without recording a blind verdict first.'
        : `${bypassedAssessments} assessment(s) were opened without a blind verdict. Those reviews are `
          + 'not in the sample above, so the agreement figure describes only the reviews that were blinded.',
    },
  };
}

function isDisposition(value: string): value is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(value);
}
