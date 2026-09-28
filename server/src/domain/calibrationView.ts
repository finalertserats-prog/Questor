// The calibration block on an assessment: the interface the assessment page
// renders, published here so the page and the engine cannot drift.
//
// THIS FILE IS A CONTRACT WITH THE ASSESSMENT PAGE. The page is owned by
// another lane; this lane owns the data. What the page must show, per
// competency that carries a calibration:
//
//     AI level          the model's own grade                     (`aiLevel`)
//     Calibrated level  what this role's reviewers read that as   (`calibratedLevel`)
//     Human level       what THIS reviewer recorded, if they did  (`humanLevel`)
//
// Rules for rendering, and they are not stylistic:
//
//   * NEVER show the calibrated level without the AI's own beside it. The
//     product's promise is that the model's own reading is always visible.
//   * The human's level, where one exists, is the one the team acts on. It
//     beats both of the others and should read as the answer, not a third
//     opinion.
//   * `statement` is the provenance and must be shown wherever the calibrated
//     level is — "adjusted -0.5: 18 reviews, 4 reviewers, since 12 Aug 2026".
//     A moved score without its evidence is the thing this design exists to
//     prevent.
//   * `rows` is empty for every assessment made before a calibration existed,
//     and for every organisation with calibration off, which is the default.
//     An empty block renders as nothing at all, not as an empty section.
//
// Pure, so the page's lane can test against it without a database.

import type { AssessmentResult, CompetencyCalibrationNote } from './types.js';
import type { AssessmentDifferences } from './reviewedAssessment.js';

/**
 * One calibrated competency, in the exact shape the page renders.
 *
 * `competencyId` matches the id on the assessment result's own competency, so
 * the page can line the row up with the level it already shows. `level` is the
 * calibrated level. `provenance` is the line rendered under the number, and it
 * carries the evidence: "adjusted -0.5: 18 reviews, 4 reviewers, since 12 Aug
 * 2026". A row with no usable id or level is dropped rather than rendered
 * blank, so this function never emits one.
 */
export interface CalibrationCompetencyView {
  readonly competencyId: string;
  readonly level: number | null;
  readonly provenance: string;
}

export interface AssessmentCalibration {
  /** One entry per competency whose level was moved. Absent means: render nothing. */
  readonly competencies?: readonly CalibrationCompetencyView[];
  /** The line above the table, or absent when there is nothing to say. */
  readonly note?: string;
}

const EMPTY: AssessmentCalibration = {};

/**
 * The calibration block for one assessment.
 *
 * Built from what was stored ON the assessment at the time it was written, not
 * from the adjustments as they stand now. That is what makes an old assessment
 * still explain itself after the adjustment behind it has been reverted or
 * recomputed — and it is the same reason the assessment is never rewritten.
 */
export function assessmentCalibration(
  result: AssessmentResult | null,
  differences: AssessmentDifferences | null,
): AssessmentCalibration {
  if (!result || !Array.isArray(result.competencies)) return EMPTY;
  const humanLevels = new Map<string, number | null>();
  const humanChanged = new Set<string>();
  for (const d of differences?.competencies ?? []) {
    humanLevels.set(d.competencyId, d.humanLevel);
    if (d.changed) humanChanged.add(d.competencyId);
  }

  const competencies: CalibrationCompetencyView[] = [];
  for (const competency of result.competencies) {
    const note: CompetencyCalibrationNote | undefined = competency.calibration;
    if (!note || typeof competency.calibratedLevel !== 'number') continue;
    // Both must be usable or the page would render a blank row. Dropped here
    // rather than there, so the page never has to decide.
    if (!competency.id) continue;

    const human = humanLevels.get(competency.id);
    const decided = humanChanged.has(competency.id) && typeof human === 'number';
    competencies.push({
      competencyId: competency.id,
      level: competency.calibratedLevel,
      // Everything a reader needs to reconstruct the movement, in one line:
      // what the model itself graded, what was applied and on what evidence,
      // and — where a person has since reviewed it — that their level is the
      // one that counts.
      provenance: [
        `The model graded ${formatLevel(competency.level)}; ${lower(note.statement)}`,
        decided
          ? `A reviewer has since recorded ${formatLevel(human as number)}, which is the level the team acts on.`
          : '',
      ].filter(Boolean).join(' '),
    });
  }
  if (competencies.length === 0) return EMPTY;

  const count = competencies.length;
  return {
    competencies,
    note: `${count} competenc${count === 1 ? 'y was' : 'ies were'} assessed at the level this role's own reviewers have consistently read this evidence at, rather than the one the model reached on its own. The model's own level is kept and shown in each line below. This was applied when the interview was assessed; nothing already assessed is ever changed.`,
  };
}

function formatLevel(level: number | null): string {
  return level === null ? 'no level' : `${level}/5`;
}

/** "Adjusted -0.5: ..." reads as a sentence continuation here, not a new one. */
function lower(statement: string): string {
  return statement.charAt(0).toLowerCase() + statement.slice(1);
}
