import { CorruptRecordError, prisma, parseJsonStrict } from '../db.js';
import { logger } from '../logger.js';
import type { AssessmentResult } from '../domain/types.js';
import {
  AGREEMENT_GATE, BLIND_BYPASS_ACTION, BLIND_REVIEW_STATUS, DISPOSITIONS, MINIMUM_N, isDisposition, round,
} from './shadowModeCommon.js';
import { computeCohenKappa, type KappaResult } from './shadowModeKappa.js';

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
   * How often blinding was skipped, and what else is missing from the sample —
   * `note` also carries the count of blind verdicts whose competency overrides
   * could not be read. Present only on the DB-backed report;
   * `computeAgreementReport` is a pure function over observations and has no
   * view of either.
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
  let unreadableOverrides = 0;
  let unreadableResults = 0;

  for (const review of blindReviews) {
    // One observation per assessment. Two reviewers blind-reviewing the same
    // assessment would otherwise enter the sample as two independent data
    // points about the model when they are two opinions about one interview.
    if (seen.has(review.assessmentId)) continue;
    if (!isDisposition(review.disposition)) continue;
    seen.add(review.assessmentId);

    // Same treatment as unreadable overrides: the verdict and the stored
    // recommendation stay in the sample, the AI's levels are missing, and the
    // loss is counted rather than read as "the AI scored nothing".
    const result = readAiResult(review.assessment);
    if (result === null) unreadableResults++;
    const aiLevels = new Map<string, { name: string; level: number }>();
    for (const c of result?.competencies ?? []) {
      if (typeof c.level === 'number' && !c.notEnoughEvidence) aiLevels.set(c.id, { name: c.name, level: c.level });
    }

    // A damaged overrides row used to read as "this reviewer graded no
    // competencies", so its pairs vanished from the competency-level kappa and
    // the report described a sample larger than the one it actually used. The
    // verdict itself is kept — only the levels are missing — and the loss is
    // counted so it can be stated instead of absorbed.
    const humanLevels = readOverrides(review.overridesJson);
    if (humanLevels === null) unreadableOverrides++;
    const competencies: Array<ShadowObservation['competencies'][number]> = [];
    for (const entry of humanLevels ?? []) {
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

  const bypassNote = bypassedAssessments === 0
    ? 'No reviewer has opened an assessment without recording a blind verdict first.'
    : `${bypassedAssessments} assessment(s) were opened without a blind verdict. Those reviews are `
      + 'not in the sample above, so the agreement figure describes only the reviews that were blinded.';
  // Reported next to the bypass count because both answer the same question:
  // how much of what this report claims to measure is actually in the sample.
  const overridesNote = unreadableOverrides === 0
    ? ''
    : ` ${unreadableOverrides} blind verdict(s) had unreadable competency overrides, so their competency `
      + 'levels are missing from the sample above and the competency-level statistics rest on fewer pairs '
      + 'than the verdict count suggests.';
  const resultsNote = unreadableResults === 0
    ? ''
    : ` ${unreadableResults} AI result(s) could not be read, so their competency levels are missing from the `
      + 'sample above; the verdicts against them still count.';

  return {
    ...report,
    blindingBypassed: {
      events: bypasses.length,
      assessments: bypassedAssessments,
      note: `${bypassNote}${overridesNote}${resultsNote}`,
    },
  };
}

/**
 * Competency overrides as recorded by a blind verdict, or null when the row
 * cannot be read. Distinguished from an empty list on purpose: "graded nothing"
 * and "we lost what they graded" are different facts about the sample.
 */
function readOverrides(json: string | null): Array<{ competencyId?: unknown; to?: unknown }> | null {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as Array<{ competencyId?: unknown; to?: unknown }> : null;
  } catch {
    return null;
  }
}

/** The AI's stored result, or null when the row cannot be read (logged by id). */
function readAiResult(assessment: { id: string; resultJson: string }): AssessmentResult | null {
  try {
    return parseJsonStrict<AssessmentResult>(assessment.resultJson, { model: 'AssessmentVersion', id: assessment.id, field: 'resultJson' });
  } catch (err) {
    if (!(err instanceof CorruptRecordError)) throw err;
    logger.error(err.record, 'Stored AI result is unreadable; excluded from competency agreement');
    return null;
  }
}
