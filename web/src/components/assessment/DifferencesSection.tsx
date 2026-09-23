import { Icon } from '../Icon';
import { isVerdict, verdictLabel } from './verdictVocabulary';
import {
  changedCount, differenceRows, readCalibration, type DifferenceInput,
} from './differencesModel';

/**
 * Part 3: where the AI's reading and the reviewer's differ.
 *
 * Both values, side by side, and the reviewer's own reason where they changed
 * something. Nothing here characterises the disagreement, ranks it, or
 * explains it away — not "the reviewer graded higher", not "the AI was
 * probably scoring the interrupted section". Whoever reads this record later
 * is reading it because something is at stake, and a system that annotates the
 * human's disagreement is putting its thumb on that scale.
 *
 * The AI's own honest caveat lives beside its reading in Part 1, not here: a
 * disclaimer in the comparison would read as an excuse for one of the two
 * columns.
 */

export interface DifferencesView {
  readonly competencies: readonly DifferenceInput[];
  readonly disposition: { readonly ai: string; readonly human: string; readonly agreed: boolean };
  readonly reason: string;
  readonly comments: string;
  readonly summary: string;
  readonly reviewedAt: string | null;
}

/**
 * The one sentence about what human reviews change — checked against the code,
 * and deliberately short of the claims this kind of sentence usually makes.
 *
 * What is true today:
 *  - every completed review is compared with the AI's reading and stored
 *    (server/src/services/assessmentReview.ts → ReviewDifference);
 *  - those pairs are the sample the agreement statistics are counted from
 *    (server/src/services/shadowModeAgreement.ts, shown by ValidationStatus);
 *  - reviewer agreement per question block feeds the library's trial report
 *    (server/src/library/trialReport.ts), and entries are promoted or retired
 *    on how they perform (server/src/library/lifecycle.ts).
 *
 * What is NOT true, and is therefore said plainly: no model is trained or
 * fine-tuned on candidate data. If any of the three facts above stops being
 * true, this sentence has to change with it.
 */
const LEARNING_SENTENCE =
  'Every recorded review is kept beside the AI\'s reading and compared — the verdicts and each competency '
  + 'level — and those comparisons are the sample the agreement statistics are counted from, and they feed '
  + 'the question library\'s trial report, where questions are promoted or retired on how they perform. '
  + 'No model is trained or fine-tuned on candidate data.';

export function LearningNote() {
  return (
    <p className="as-learning" data-testid="learning-note">
      <b>What this record is used for.</b> {LEARNING_SENTENCE}
    </p>
  );
}

export function DifferencesSection({ differences, calibration }: {
  readonly differences: DifferencesView | null;
  /** From the calibration lane, when it is there. Absent is the ordinary case. */
  readonly calibration?: unknown;
}) {
  if (!differences) {
    return (
      <>
        <p className="as-empty" data-testid="differences-empty">
          Nothing to compare yet. This fills in the moment a verdict is recorded: every competency where the
          reviewer&rsquo;s level differs from the AI&rsquo;s, and whether the two verdicts matched.
        </p>
        <LearningNote />
      </>
    );
  }

  // One vocabulary (verdictVocabulary.ts). An unrecognised value is shown as
  // nothing rather than guessed at: the comparison is the record.
  const say = (value: string) => (isVerdict(value) ? verdictLabel(value) : '—');
  const rows = differenceRows(differences.competencies);
  const changed = changedCount(differences.competencies);
  const cal = readCalibration(calibration);

  return (
    <>
      <div className="as-diff-overall" data-testid="differences-overall">
        <p className="as-diff-micro">Overall</p>
        <p className="as-diff-pair">
          <span><span className="k">AI</span> <b>{say(differences.disposition.ai)}</b></span>
          <span><span className="k">Reviewer</span> <b>{say(differences.disposition.human)}</b></span>
          <span><span className="k">Same verdict</span> <b>{differences.disposition.agreed ? 'Yes' : 'No'}</b></span>
        </p>
      </div>

      <p className="as-diff-count">
        {changed === 0
          ? 'The reviewer left every competency level as the AI had it.'
          : `The reviewer changed ${changed} of ${rows.length} competency levels.`}
      </p>

      {cal.present && cal.note && <p className="as-diff-cal-note" data-testid="calibration-note">{cal.note}</p>}

      <div className="table-scroll" tabIndex={0} role="region" aria-label="Where the AI and the reviewer differ">
        <table className="as-diff" data-testid="differences-table">
          <thead>
            <tr>
              <th>Competency</th>
              <th>AI</th>
              {cal.present && <th>Calibrated</th>}
              <th>Reviewer</th>
              <th>Reviewer&rsquo;s reason for the change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const entry = cal.byCompetency.get(row.competencyId);
              return (
                <tr key={row.competencyId} className={row.changed ? 'is-changed' : undefined}>
                  <td>{row.competencyName}</td>
                  <td className="as-diff-num">{row.aiText}</td>
                  {cal.present && (
                    <td className="as-diff-num">
                      {entry && entry.level !== null ? `${entry.level}/5` : '—'}
                      {entry?.provenance && <span className="as-diff-prov">{entry.provenance}</span>}
                    </td>
                  )}
                  <td className="as-diff-num">{row.changed ? <b>{row.humanText}</b> : row.humanText}</td>
                  <td className="as-diff-why">{row.changed ? row.reason : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="as-diff-neutral" data-testid="differences-neutral">
        <Icon name="about" size={14} />
        Both values, and nothing else. The AI does not comment on, rate or explain away a reviewer&rsquo;s
        disagreement — whoever reads this later should weigh the two readings themselves.
      </p>

      <LearningNote />
    </>
  );
}
