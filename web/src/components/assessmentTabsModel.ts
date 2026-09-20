/**
 * The assessment page's three tabs, kept free of React so their order,
 * addresses, keyboard movement and the difference table are tested on their
 * own (web/tests/assessmentTabsModel.test.ts).
 *
 * Human first: once a person has reviewed an interview, theirs is the reading
 * the team acts on. The AI's own output stays beside it, unchanged, and the
 * third tab is what the two disagreed about — the record the AI is meant to
 * learn from, and the honest answer to "was the review meaningful?".
 */

export type AssessmentTabKey = 'human' | 'ai' | 'differences';

export interface AssessmentTab {
  readonly key: AssessmentTabKey;
  readonly label: string;
}

export const ASSESSMENT_TABS: readonly AssessmentTab[] = [
  { key: 'human', label: 'Human review' },
  { key: 'ai', label: 'AI assessment' },
  { key: 'differences', label: 'Key differences' },
];

export const DEFAULT_ASSESSMENT_TAB: AssessmentTabKey = 'human';

/**
 * The tab an address names, or null when it names none — which is the plain
 * assessment address, and means "show whichever reading makes sense"
 * (landingTab). Every tab also has an address of its own, so choosing one is
 * a link a person can send.
 */
export function assessmentTabFromParam(param: string | undefined): AssessmentTabKey | null {
  if (param === undefined) return null;
  return ASSESSMENT_TABS.find((tab) => tab.key === param)?.key ?? null;
}

export function assessmentTabPath(assessmentId: string, key: AssessmentTabKey): string {
  return `/assessments/${assessmentId}/${key}`;
}

export function assessmentTabId(key: AssessmentTabKey): string { return `assessment-${key}-tab`; }
export function assessmentPanelId(key: AssessmentTabKey): string { return `assessment-${key}-panel`; }

/** Arrow keys move along the tabs and wrap; Home and End jump to either end. */
export function nextAssessmentTab(current: AssessmentTabKey, key: string): AssessmentTabKey {
  const index = ASSESSMENT_TABS.findIndex((tab) => tab.key === current);
  if (key === 'Home') return ASSESSMENT_TABS[0].key;
  if (key === 'End') return ASSESSMENT_TABS[ASSESSMENT_TABS.length - 1].key;
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return current;
  const delta = key === 'ArrowRight' ? 1 : -1;
  return ASSESSMENT_TABS[(index + delta + ASSESSMENT_TABS.length) % ASSESSMENT_TABS.length].key;
}

/**
 * Which tab to show when the address does not say: the human review when
 * there is one, otherwise the AI's assessment — landing on an empty tab and
 * making the reader hunt for the content helps nobody.
 */
export function landingTab(opts: { reviewed: boolean; requested: AssessmentTabKey | undefined }): AssessmentTabKey {
  if (opts.requested) return opts.requested;
  return opts.reviewed ? 'human' : 'ai';
}

export interface ReviewSummary {
  readonly disposition: string;
  readonly reason: string;
  readonly comments: string;
  readonly completedAt: string | null;
  readonly reviewerId: string;
}

export type HumanTabState =
  | { readonly kind: 'none'; readonly message: string }
  | { readonly kind: 'reviewed'; readonly review: ReviewSummary };

const NO_REVIEW = 'No review has been recorded for this interview yet. The AI assessment is on the next tab; '
  + 'record your verdict below and it becomes the version the team works from.';

export function humanTabState(review: ReviewSummary | null): HumanTabState {
  return review ? { kind: 'reviewed', review } : { kind: 'none', message: NO_REVIEW };
}

/** Levels are shown as the scorecard writes them, and never invented. */
export function levelText(level: number | null): string {
  return level === null ? 'Not graded' : `${level}/5`;
}

export interface DifferenceInput {
  readonly competencyId: string;
  readonly competencyName: string;
  readonly aiLevel: number | null;
  readonly humanLevel: number | null;
  readonly changed: boolean;
  readonly reason: string;
}

export interface DifferenceRow extends DifferenceInput {
  readonly direction: 'up' | 'down' | 'same';
  readonly aiText: string;
  readonly humanText: string;
}

const NO_REASON = 'No reason given.';

/**
 * Changed rows first: the page exists to show where the human and the machine
 * parted company. The rows they agreed on stay, because agreement is the
 * other half of the same measurement.
 */
export function differenceRows(rows: readonly DifferenceInput[]): DifferenceRow[] {
  const direction = (row: DifferenceInput): DifferenceRow['direction'] => {
    if (!row.changed || row.aiLevel === null || row.humanLevel === null) return 'same';
    if (row.humanLevel > row.aiLevel) return 'up';
    return row.humanLevel < row.aiLevel ? 'down' : 'same';
  };
  return [...rows]
    .sort((a, b) => Number(b.changed) - Number(a.changed))
    .map((row) => ({
      ...row,
      direction: direction(row),
      aiText: levelText(row.aiLevel),
      humanText: levelText(row.humanLevel),
      reason: row.changed ? (row.reason.trim() || NO_REASON) : row.reason,
    }));
}
