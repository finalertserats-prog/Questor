import { Banner } from '../ui';
import {
  COMPARISON_LABELS, COMPARISON_TONE, comparisonHeadline, compareFitWithInterview,
  strengthLabel, type ComparisonRow, type Fit, type InterviewCompetency,
} from './fitModel';

/**
 * What the CV claimed, next to what the interview actually found.
 *
 * This is the product's central claim, so it is written to be precise and kind
 * at the same time. Precise: the two sides are joined on competency id, each
 * row shows the real quotes from both, and the row says which level was
 * reached against which level was required. Kind: a competency the CV pointed
 * at and the interview did not reach is described as a conversation that did
 * not produce the evidence, because that is what happened — an hour is a small
 * sample, and a person reading this is being handed a question, not a verdict.
 *
 * The disagreements are listed first, because the rows where the two sides
 * agree are the ones nobody needs to act on.
 */

export function FitVsInterview({
  fit, interview, blockedReason,
}: {
  fit: Fit | null;
  interview: readonly InterviewCompetency[];
  blockedReason?: string | null;
}) {
  if (blockedReason) return <Banner kind="info">{blockedReason}</Banner>;
  const rows = compareFitWithInterview(fit, interview);
  if (rows.length === 0) {
    return <p className="muted">There is no line-by-line CV reading to set against this interview yet.</p>;
  }

  return (
    <div className="fvi" data-testid="fit-vs-interview">
      <p className="fvi-headline" data-testid="fvi-headline">{comparisonHeadline(rows)}</p>
      <p className="fit-note">
        The CV is what someone wrote about themselves. The interview is what they said in one conversation.
        Where the two differ, the honest reading is usually that one of them is incomplete — not that either is false.
      </p>
      <ul className="fvi-rows">
        {rows.map((row) => <Row key={row.competencyId} row={row} />)}
      </ul>
    </div>
  );
}

function Row({ row }: { row: ComparisonRow }) {
  return (
    <li className={`fvi-row is-${COMPARISON_TONE[row.kind]}`} data-testid={`fvi-row-${row.competencyId}`}>
      <div className="fvi-row-head">
        <b>{row.name}</b>
        <span className="fvi-kind" data-testid={`fvi-kind-${row.competencyId}`}>{COMPARISON_LABELS[row.kind]}</span>
      </div>
      <p className="fit-note">{row.sentence}</p>
      <div className="fvi-sides">
        <div className="fvi-side">
          <h4 className="fit-h4">On the CV <span className="fit-strength">{strengthLabel(row.cvStrength)}</span></h4>
          {row.cvEvidence.length === 0
            ? <p className="fit-note">Nothing on the CV speaks to this.</p>
            : (
              <ul className="fit-quotes">
                {row.cvEvidence.slice(0, 2).map((e) => (
                  <li key={e.line}><q>{e.quote}</q><span className="fit-where">CV line {e.line + 1}</span></li>
                ))}
              </ul>
            )}
        </div>
        <div className="fvi-side">
          <h4 className="fit-h4">
            In the interview
            {row.interviewLevel !== null && row.requiredLevel !== null && (
              <span className="fit-strength">level {row.interviewLevel} of a required {row.requiredLevel}</span>
            )}
          </h4>
          {row.interviewEvidence.length === 0
            ? <p className="fit-note">The conversation produced no quotable evidence for this.</p>
            : (
              <ul className="fit-quotes">
                {row.interviewEvidence.slice(0, 2).map((e) => (
                  <li key={e.turnId}><q>{e.quote}</q><span className="fit-where">from the transcript</span></li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </li>
  );
}
