/**
 * The scorecard's one arithmetic rule, kept free of React so it can be unit
 * tested (see web/tests/scorecardModel.test.ts).
 */

import { hasScore } from './scoreFormat';

/** Competencies with this classification score nothing, and weigh nothing. */
const NON_SCORING = 'non_scoring';

/** The rounding slack the server allows before it refuses the save. */
export const WEIGHT_TOLERANCE_POINTS = 2;

export interface WeightedCompetency {
  readonly classification: string;
  readonly weight: number;
}

/** The scored competencies' weights, as whole percentage points. */
export function weightsTotal(competencies: readonly WeightedCompetency[]): number {
  const sum = competencies
    .filter((c) => c.classification !== NON_SCORING)
    .reduce((total, c) => total + (hasScore(c.weight) ? c.weight : 0), 0);
  return Math.round(sum * 100);
}

/**
 * Why the save cannot go through, in the server's own words, or null.
 *
 * WHY the server's wording rather than our own: the same rule is enforced on
 * PUT /roles/:id/scorecard, and a page that phrased it differently would be
 * describing a second, slightly different rule — the kind of divergence nobody
 * notices until the two disagree.
 */
export function weightsProblem(competencies: readonly WeightedCompetency[]): string | null {
  const total = weightsTotal(competencies);
  if (Math.abs(total - 100) <= WEIGHT_TOLERANCE_POINTS) return null;
  return `Weights of the scored competencies total ${total}%; they must total 100%.`;
}
