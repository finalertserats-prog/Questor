import { round } from './shadowModeCommon.js';

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
