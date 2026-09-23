/**
 * Where the AI's reading and the reviewer's parted company.
 *
 * Moved here from components/assessmentTabsModel.ts when the assessment page
 * stopped being three tabs and became three marked parts of one page. What
 * came with it is the comparison itself; what was left behind was the tab
 * machinery and the "human tab" panel, which the page no longer has.
 *
 * NOTHING HERE CHARACTERISES THE DISAGREEMENT. The old panel labelled each row
 * "Reviewer graded higher" / "Reviewer graded lower", which reads as the
 * system marking the human's work. An adversarial review flagged that it would
 * bias whoever read the record later — in an appeal, in an audit, in a
 * tribunal — so the rows now show both values and the reviewer's own reason,
 * and let the reader judge. `changed` is a fact; a verdict on the change is
 * not ours to offer.
 */

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
  readonly aiText: string;
  readonly humanText: string;
}

const NO_REASON = 'No reason given.';

/**
 * Changed rows first: the section exists to show where the two readings
 * differ. The rows they agreed on stay, because agreement is the other half of
 * the same measurement — a differences table that hid them would overstate how
 * often the reviewer disagrees.
 */
export function differenceRows(rows: readonly DifferenceInput[]): DifferenceRow[] {
  return [...rows]
    .sort((a, b) => Number(b.changed) - Number(a.changed))
    .map((row) => ({
      ...row,
      aiText: levelText(row.aiLevel),
      humanText: levelText(row.humanLevel),
      reason: row.changed ? (row.reason.trim() || NO_REASON) : row.reason,
    }));
}

/** How many of the competencies the reviewer changed, said plainly. */
export function changedCount(rows: readonly DifferenceInput[]): number {
  return rows.filter((row) => row.changed).length;
}

// ---------------------------------------------------------------------------
// Calibration (feature/role-calibration), rendered only if it is there
// ---------------------------------------------------------------------------

/**
 * A per-role calibrated level, published by the calibration lane.
 *
 * This page does not compute it and does not require it. An older server, a
 * role with too few reviews to calibrate, or the lane not having landed yet
 * all arrive here as "absent", and the section renders exactly as it does
 * today — two columns, AI and reviewer. When the data IS present a third
 * column appears between them, with the provenance said in words rather than
 * implied by a number.
 */
export interface CalibrationEntry {
  readonly competencyId: string;
  readonly level: number | null;
  /** Said to the reader: what this calibrated level was derived from. */
  readonly provenance: string;
}

export interface CalibrationView {
  readonly competencies?: readonly CalibrationEntry[] | null;
  /** One sentence about the calibration as a whole. */
  readonly note?: string | null;
}

export interface CalibrationLevels {
  readonly present: boolean;
  readonly byCompetency: ReadonlyMap<string, CalibrationEntry>;
  readonly note: string;
}

const NO_CALIBRATION: CalibrationLevels = { present: false, byCompetency: new Map(), note: '' };

/**
 * Read whatever the server sent, defensively. Anything that is not a usable
 * entry is dropped rather than rendered as a blank cell, and a payload with no
 * usable entries at all is the same as no payload: the column does not appear.
 */
export function readCalibration(raw: unknown): CalibrationLevels {
  if (!raw || typeof raw !== 'object') return NO_CALIBRATION;
  const view = raw as CalibrationView;
  const entries = Array.isArray(view.competencies) ? view.competencies : [];
  const usable = entries.filter((entry): entry is CalibrationEntry =>
    Boolean(entry)
    && typeof entry === 'object'
    && typeof (entry as CalibrationEntry).competencyId === 'string'
    && (entry as CalibrationEntry).competencyId !== ''
    && (typeof (entry as CalibrationEntry).level === 'number' || (entry as CalibrationEntry).level === null));
  if (usable.length === 0) return NO_CALIBRATION;
  return {
    present: true,
    byCompetency: new Map(usable.map((entry) => [entry.competencyId, {
      competencyId: entry.competencyId,
      level: typeof entry.level === 'number' ? entry.level : null,
      provenance: typeof entry.provenance === 'string' ? entry.provenance : '',
    }])),
    note: typeof view.note === 'string' ? view.note : '',
  };
}
