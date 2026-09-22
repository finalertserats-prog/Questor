/**
 * The role page's candidate comparison, kept free of React so it can be unit
 * tested (see web/tests/comparisonModel.test.ts).
 *
 * The sort keys and the cell vocabulary are the browser's copy of
 * server/src/domain/candidateComparison.ts — the browser cannot import from the
 * server workspace. A copy that drifts is how two vocabularies grow, so
 * server/tests/comparisonVocabulary.test.ts compares the two as text and fails
 * if they part company.
 */

export const SORT_KEYS = ['verdict', 'score', 'stage', 'recency', 'name'] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  readonly key: SortKey;
  readonly dir: SortDirection;
}

export const DEFAULT_DIRECTION: Readonly<Record<SortKey, SortDirection>> = {
  verdict: 'desc',
  score: 'desc',
  stage: 'desc',
  recency: 'desc',
  name: 'asc',
};

export const DEFAULT_SORT: SortState = { key: 'recency', dir: 'desc' };

export const COLUMN_LABELS: Readonly<Record<SortKey, string>> = {
  name: 'Candidate',
  stage: 'Stage',
  verdict: 'Verdict',
  score: 'AI score',
  recency: 'Last moved',
};

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * The sort after a click on a column heading. A column that is already the
 * sort reverses; a new one opens at the end a manager is looking for, which
 * for every column but the name is the strongest value first.
 */
export function nextSort(current: SortState, clicked: SortKey): SortState {
  if (current.key !== clicked) return { key: clicked, dir: DEFAULT_DIRECTION[clicked] };
  return { key: clicked, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

export function ariaSort(current: SortState, key: SortKey): 'ascending' | 'descending' | undefined {
  if (current.key !== key) return undefined;
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

/** The sort held in the address, so a link and the back button return to the same order. */
export function sortFromParams(params: URLSearchParams): SortState {
  const key = params.get('sort');
  const dir = params.get('dir');
  if (!isSortKey(key)) return DEFAULT_SORT;
  return { key, dir: dir === 'asc' || dir === 'desc' ? dir : DEFAULT_DIRECTION[key] };
}

export function sortToParams(sort: SortState): Readonly<Record<string, string>> {
  return { sort: sort.key, dir: sort.dir };
}

// ---------------------------------------------------------------------------
// The skills grid
// ---------------------------------------------------------------------------

export type GridCell =
  | { readonly kind: 'level'; readonly level: number }
  | { readonly kind: 'no_evidence' }
  | { readonly kind: 'not_assessed' };

export const LEVEL_MAX = 5;

export const NO_EVIDENCE_LABEL = 'No evidence';
export const NOT_ASSESSED_LABEL = 'Not assessed';

/**
 * What a cell reads as.
 *
 * Never a zero. A zero in a column of levels reads as "scored badly", which is
 * a statement about the candidate that "the interview produced nothing to
 * grade this on" does not make.
 */
export function cellLabel(cell: GridCell): string {
  if (cell.kind === 'level') return String(cell.level);
  return cell.kind === 'no_evidence' ? NO_EVIDENCE_LABEL : NOT_ASSESSED_LABEL;
}

/** The long form, for the cell's title and for a screen reader. */
export function cellTitle(cell: GridCell, competencyName: string, requiredLevel: number): string {
  if (cell.kind === 'not_assessed') {
    return `${competencyName}: this competency was not put to this candidate.`;
  }
  if (cell.kind === 'no_evidence') {
    return `${competencyName}: the interview did not produce evidence to grade this on. It is not a low score.`;
  }
  const against = requiredLevel >= 1 ? ` against ${requiredLevel} asked for` : '';
  return `${competencyName}: level ${cell.level} of ${LEVEL_MAX}${against}.`;
}

export type CellStanding = 'above' | 'meets' | 'below';

/**
 * How a level stands against the role's required level, so the grid can mark
 * it with weight, a rule and a small mark rather than a tinted fill.
 */
export function cellStanding(level: number, requiredLevel: number): CellStanding | null {
  if (!Number.isFinite(requiredLevel) || requiredLevel < 1) return null;
  if (level > requiredLevel) return 'above';
  return level === requiredLevel ? 'meets' : 'below';
}

/** One mark per point of the scale, filled up to the level. */
export function levelTicks(level: number): boolean[] {
  return Array.from({ length: LEVEL_MAX }, (_, i) => i < level);
}

// ---------------------------------------------------------------------------
// The shortlist
// ---------------------------------------------------------------------------

export const MIN_COMPARISON = 2;

/** What the shortlist bar says, so the next step is never a disabled button with no reason. */
export function shortlistHint(count: number, max: number): string {
  if (count === 0) return 'Tick candidates to hold them side by side.';
  if (count < MIN_COMPARISON) return 'Tick one more to compare them side by side.';
  if (count >= max) return `Your shortlist is full at ${max}. Untick someone to swap them out.`;
  return `Compare these ${count} side by side.`;
}

/** The API path for a side-by-side of these candidates. */
export function comparisonPath(roleId: string, candidateIds: readonly string[]): string {
  const params = new URLSearchParams({ ids: candidateIds.join(',') });
  return `/roles/${encodeURIComponent(roleId)}/candidates/comparison?${params.toString()}`;
}

export function shortlistPath(roleId: string): string {
  return `/roles/${encodeURIComponent(roleId)}/shortlist`;
}
