import { isVerdict, VERDICTS, type Verdict } from './verdict.js';

/**
 * The rules for putting a role's candidates beside each other.
 *
 * Hiring is comparative, but the product handled one candidate at a time, so
 * these rules are new rather than moved. They live in `domain/` and take plain
 * values so they can be tested without a database, and so the ordering the
 * server applies is the ordering the page describes — the sort happens on the
 * server, and this is the whole of it.
 */

export const SORT_KEYS = ['verdict', 'score', 'stage', 'recency', 'name'] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export type SortDirection = 'asc' | 'desc';

/**
 * Which way a column opens when it is first clicked. A name starts at A; every
 * other column starts at the end a manager is looking for — the strongest
 * verdict, the highest score, the furthest through, the most recent.
 */
export const DEFAULT_DIRECTION: Readonly<Record<SortKey, SortDirection>> = {
  verdict: 'desc',
  score: 'desc',
  stage: 'desc',
  recency: 'desc',
  name: 'asc',
};

export const DEFAULT_SORT: SortKey = 'recency';

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * A verdict as a number to sort by, in the one vocabulary (domain/verdict.ts).
 *
 * Null for anything that is not one of the three words — including the stored
 * pipeline enums. A row whose verdict is being withheld from this viewer by the
 * blind-review policy has no verdict here either, so the order cannot leak what
 * the page is refusing to show.
 */
export function verdictRank(verdict: string | null | undefined): number | null {
  if (!isVerdict(verdict)) return null;
  const order: Readonly<Record<Verdict, number>> = { DO_NOT_PROGRESS: 1, CONSIDER: 2, PROCEED: 3 };
  return order[verdict];
}

export interface SortableCandidate {
  readonly id: string;
  readonly name: string;
  /** PROCEED | CONSIDER | DO_NOT_PROGRESS, or null when there is none to show. */
  readonly verdict: string | null;
  /** 0..100, or null when nothing was scored. Zero is a score; null is not. */
  readonly score: number | null;
  /** 1-based position in this role's stage plan; null with no pipeline. */
  readonly stageOrder: number | null;
  /** When the application last moved, in epoch milliseconds. */
  readonly movedAt: number;
}

function sortValue(row: SortableCandidate, key: SortKey): number | string | null {
  switch (key) {
    case 'verdict': return verdictRank(row.verdict);
    case 'score': return row.score;
    case 'stage': return row.stageOrder;
    case 'recency': return row.movedAt;
    case 'name': return row.name.toLowerCase();
  }
}

/**
 * The page in order.
 *
 * Rows with nothing to compare sit at the foot in BOTH directions. Reversing a
 * "best first" sort should show the weakest candidate, not the pile of people
 * nobody has interviewed yet; a gap is not a low score, and sorting it as one
 * is how a shortlist ends up built out of missing data.
 */
export function sortCandidates(
  rows: readonly SortableCandidate[],
  key: SortKey,
  direction: SortDirection,
): SortableCandidate[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av === null && bv === null) return tieBreak(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return tieBreak(a, b);
  });
}

/** Name, then id: the same page must not come back in a different order. */
function tieBreak(a: SortableCandidate, b: SortableCandidate): number {
  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return byName !== 0 ? byName : a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// The skills grid
// ---------------------------------------------------------------------------

export type GridCell =
  | { readonly kind: 'level'; readonly level: number }
  /** Graded, and the transcript did not support a judgement. Never a zero. */
  | { readonly kind: 'no_evidence' }
  /** This competency was never put to this candidate — a later addition, or no interview yet. */
  | { readonly kind: 'not_assessed' };

export interface ScoredCell {
  readonly level: number | null;
  readonly notEnoughEvidence: boolean;
  readonly gradingUnavailable?: boolean;
}

/**
 * One cell of the grid.
 *
 * "No evidence" and "not assessed" are different facts and are said
 * differently: one means the interview covered it and found nothing to grade,
 * the other that the competency and the candidate never met. Neither is ever a
 * zero — a zero in a column of levels reads as "scored badly", which is a
 * statement about the candidate the data does not make.
 */
export function gridCell(scored: ScoredCell | null | undefined): GridCell {
  if (!scored) return { kind: 'not_assessed' };
  if (scored.notEnoughEvidence || scored.gradingUnavailable) return { kind: 'no_evidence' };
  if (typeof scored.level !== 'number' || !Number.isFinite(scored.level) || scored.level < 1) return { kind: 'no_evidence' };
  return { kind: 'level', level: scored.level };
}

export type CellStanding = 'above' | 'meets' | 'below';

/**
 * How a level stands against what the role asks for, so the grid can mark it
 * with weight and a rule rather than a tinted fill. Null when the scorecard
 * states no required level: there is nothing to stand against.
 */
export function cellStanding(level: number, requiredLevel: number): CellStanding | null {
  if (!Number.isFinite(requiredLevel) || requiredLevel < 1) return null;
  if (level > requiredLevel) return 'above';
  return level === requiredLevel ? 'meets' : 'below';
}

// ---------------------------------------------------------------------------
// Comparability
// ---------------------------------------------------------------------------

export interface ComparabilitySource {
  readonly candidateId: string;
  /** The scorecard version the assessment was made against; null with no assessment. */
  readonly scorecardVersion: number | null;
  readonly competenciesGraded: number | null;
  readonly durationMinutes: number | null;
}

export interface ComparabilityNote {
  readonly kind: 'scorecard_version' | 'interview_depth';
  readonly text: string;
}

/**
 * Minutes of difference below which two interviews are the same interview. A
 * session that ran four minutes short is not a shallower assessment; saying so
 * on every row would make the note mean nothing by the time it mattered.
 */
const DEPTH_MINUTES_TOLERANCE = 10;

/**
 * Where scores being read together were not produced the same way.
 *
 * A number next to another number reads as the same measurement. It is not one
 * when the candidates were assessed against different versions of the
 * scorecard, or when one interview covered half the competencies of the other.
 * Rather than quietly drop those rows — which would hide the candidate — the
 * page keeps them and says what is different, so the person comparing decides
 * what to do about it.
 *
 * The two notes are measured against different things ON PURPOSE.
 *
 * A SCORECARD VERSION is measured against the role's current one
 * (`roleScorecardVersion`), which is a fact about the role and does not move.
 * Measuring it against whoever happens to share the page would mark a
 * candidate on page one and clear the same candidate on page two, which reads
 * as the data changing under the reader.
 *
 * DEPTH is measured against the others being read together, because that is
 * the only thing it can mean: "shallower" is a comparison, and the question a
 * manager is asking is whether the evidence behind THESE figures is even.
 */
export function comparabilityNotes(
  rows: readonly ComparabilitySource[],
  roleScorecardVersion?: number,
): ReadonlyMap<string, readonly ComparabilityNote[]> {
  const assessed = rows.filter((r) => r.scorecardVersion !== null);
  const current = roleScorecardVersion ?? Math.max(...assessed.map((r) => r.scorecardVersion ?? 0), 0);
  const deepest = Math.max(...assessed.map((r) => r.competenciesGraded ?? 0), 0);
  const longest = Math.max(...assessed.map((r) => r.durationMinutes ?? 0), 0);

  return new Map(rows.map((row): readonly [string, readonly ComparabilityNote[]] => {
    // A candidate with no assessment has no figure to be inconsistent with.
    if (row.scorecardVersion === null) return [row.candidateId, []];
    const notes: ComparabilityNote[] = [];
    if (row.scorecardVersion < current) {
      notes.push({
        kind: 'scorecard_version',
        text: `Scored on a different scorecard version (v${row.scorecardVersion}; this role is now on v${current}) — the levels are not measured against the same rubric.`,
      });
    }
    // Nothing to be shallower than when there is only one interview here.
    if (assessed.length < 2) return [row.candidateId, notes];
    const thin = (row.competenciesGraded ?? 0) < deepest;
    const short = longest - (row.durationMinutes ?? 0) >= DEPTH_MINUTES_TOLERANCE;
    if (thin || short) notes.push({ kind: 'interview_depth', text: depthText(row, { deepest, longest, thin, short }) });
    return [row.candidateId, notes];
  }));
}

function depthText(
  row: ComparabilitySource,
  o: { deepest: number; longest: number; thin: boolean; short: boolean },
): string {
  const parts: string[] = [];
  if (o.thin) parts.push(`${row.competenciesGraded ?? 0} competencies graded against ${o.deepest}`);
  if (o.short) parts.push(`${row.durationMinutes ?? 0} minutes against ${o.longest}`);
  return `A shallower interview than the others here (${parts.join('; ')}).`;
}

/** Every verdict, for a caller that wants the vocabulary without importing twice. */
export const COMPARISON_VERDICTS = VERDICTS;
