import { Icon } from '../Icon';
import { eligibilityKindLabel } from '../fit/fitModel';

/**
 * What the advert asks a person to HOLD, as opposed to what it asks them to be
 * able to do.
 *
 * It sits on the role page beside the competencies and looks nothing like
 * them: no weight, no level, no must-pass toggle, nothing to edit. That is the
 * honest shape. A licence cannot be graded on a five-point ladder, cannot be
 * partially evidenced, and cannot be traded off against a strong interview —
 * so none of the apparatus that surrounds a competency belongs anywhere near
 * it.
 *
 * Every row quotes the line of the job description that produced it, and a
 * requirement Questor cannot quote is never proposed at all. That is the same
 * rule competency extraction lives by, applied to a stronger claim.
 */

export interface EligibilityRequirement {
  id: string;
  kind: string;
  text: string;
  line: number;
}

export function EligibilityPanel({ requirements }: { requirements: readonly EligibilityRequirement[] }) {
  if (requirements.length === 0) return null;
  return (
    <div className="card" data-testid="role-eligibility">
      <h2 className="card-title"><Icon name="flag" size={16} />Eligibility this advert asks for</h2>
      <p className="muted small">
        Requirements a candidate either meets or does not. Questor reads them off the job description, shows
        them beside every candidate with whatever their CV says, and leaves the decision with you. None of
        them is scored, interviewed or used to filter anybody.
      </p>
      <ul className="fit-reads" style={{ marginTop: 10 }}>
        {requirements.map((r) => (
          <li key={r.id} className="fit-read-row" data-testid={`role-eligibility-${r.id}`}>
            <div className="fit-read-head">
              <b>{eligibilityKindLabel(r.kind)}</b>
              <span className="fit-where">Job description line {r.line}</span>
            </div>
            <blockquote className="fit-quote-jd"><q>{r.text}</q></blockquote>
          </li>
        ))}
      </ul>
    </div>
  );
}
