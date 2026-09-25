import type { AssessmentResult, CompetencyScore, Proficiency, Recommendation } from './types.js';

/**
 * A completed human review, applied to the assessment it belongs to.
 *
 * Two things come out of this, from data already stored on HumanReview — no
 * second copy of the truth:
 *
 *   1. THE VERSION THE TEAM ACTS ON. Once someone has reviewed an interview,
 *      their levels and their disposition are the ones that count. The AI's
 *      own output is kept underneath, unchanged, so nothing is lost.
 *   2. THE DIFFERENCE. Where the reviewer disagreed, by how much and why, is
 *      the record the AI is meant to learn from, and it is also the honest
 *      answer to "was the human review meaningful?".
 *
 * Pure, so both are tested on their own (tests/reviewedAssessment.test.ts) and
 * the same answer is given to the assessment page, the candidate's feedback
 * email and anything that reports on outcomes.
 */

export interface ReviewOverride {
  readonly competencyId: string;
  readonly from: unknown;
  readonly to: unknown;
  readonly reason: string;
}

export interface CompletedReview {
  readonly id: string;
  readonly reviewerId: string;
  readonly disposition: string;
  readonly reason: string;
  readonly comments: string;
  readonly completedAt: Date | string | null;
  readonly overrides: readonly ReviewOverride[];
  /**
   * Whether the AI's reading was visible to this reviewer before they recorded
   * it. Null on reviews written before the fact was stored; never guessed
   * (domain/reviewOrdering.ts).
   */
  readonly aiVisibleBefore?: boolean | null;
}

const DISPOSITIONS: readonly Recommendation[] = ['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS'];

function isDisposition(value: string): value is Recommendation {
  return (DISPOSITIONS as readonly string[]).includes(value);
}

/** A completed review's disposition as a verdict, or null when there is no usable one. */
export function humanVerdict(disposition: string | null | undefined): Recommendation | null {
  return disposition && isDisposition(disposition) ? disposition : null;
}

function asLevel(value: unknown): Proficiency | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 5 ? (value as Proficiency) : null;
}

/**
 * The assessment as the reviewer left it: their levels where they recorded
 * one, their disposition as the recommendation.
 *
 * The overall score is dropped rather than recomputed. A weighted mean over
 * half-human, half-AI levels is a number nobody produced, and on a page about
 * what a person decided that is exactly the wrong thing to show.
 */
export function applyReviewOverrides(result: AssessmentResult, review: CompletedReview | null): AssessmentResult {
  if (!review) return result;
  const levels = new Map<string, Proficiency>();
  for (const override of review.overrides) {
    const level = asLevel(override.to);
    if (level !== null) levels.set(override.competencyId, level);
  }

  const competencies: CompetencyScore[] = result.competencies.map((c) => {
    const level = levels.get(c.id);
    if (level === undefined) return c;
    // A reviewer who grades a competency has, by doing so, said there was
    // enough to grade it on — whatever the AI concluded about the evidence.
    return { ...c, level, notEnoughEvidence: false, gradingUnavailable: false };
  });

  return {
    ...result,
    competencies,
    recommendation: isDisposition(review.disposition) ? review.disposition : result.recommendation,
    overallScore: null,
  };
}

export interface AssessmentOutcome {
  readonly source: 'human' | 'ai';
  readonly recommendation: string;
  readonly reviewedAt: Date | string | null;
}

/** What the rest of the product should report as this interview's outcome. */
export function reviewedOutcome(result: AssessmentResult, review: CompletedReview | null): AssessmentOutcome {
  if (review && isDisposition(review.disposition)) {
    return { source: 'human', recommendation: review.disposition, reviewedAt: review.completedAt };
  }
  return { source: 'ai', recommendation: result.recommendation, reviewedAt: null };
}

export interface CompetencyDifference {
  readonly competencyId: string;
  readonly competencyName: string;
  readonly aiLevel: number | null;
  readonly humanLevel: number | null;
  readonly changed: boolean;
  readonly reason: string;
}

export interface AssessmentDifferences {
  readonly competencies: readonly CompetencyDifference[];
  readonly disposition: { readonly ai: string; readonly human: string; readonly agreed: boolean };
  readonly reason: string;
  readonly comments: string;
  readonly reviewerId: string;
  readonly reviewedAt: Date | string | null;
  readonly summary: string;
}

/**
 * Every competency, said twice — what the AI graded and what the reviewer
 * left. Unchanged rows are kept: agreement is as much of a signal as
 * disagreement, and a list of only the changes cannot say how often the two
 * matched.
 */
export function assessmentDifferences(result: AssessmentResult, review: CompletedReview | null): AssessmentDifferences | null {
  if (!review) return null;
  const overrides = new Map(review.overrides.map((o) => [o.competencyId, o]));

  const competencies: CompetencyDifference[] = result.competencies.map((c) => {
    const override = overrides.get(c.id);
    const humanLevel = override ? asLevel(override.to) : null;
    return {
      competencyId: c.id,
      competencyName: c.name,
      aiLevel: c.level,
      humanLevel: humanLevel ?? c.level,
      changed: humanLevel !== null && humanLevel !== c.level,
      reason: override?.reason ?? '',
    };
  });

  const changed = competencies.filter((c) => c.changed).length;
  const agreed = review.disposition === result.recommendation;
  const counted = changed === 0 ? 'no competency levels' : `${changed} of ${competencies.length} competency levels`;
  const summary = `The reviewer changed ${counted} and ${agreed ? 'agreed with' : 'did not agree with'} the AI recommendation.`;

  return {
    competencies,
    disposition: { ai: result.recommendation, human: review.disposition, agreed },
    reason: review.reason,
    comments: review.comments,
    reviewerId: review.reviewerId,
    reviewedAt: review.completedAt,
    summary,
  };
}
