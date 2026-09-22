import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { VerdictCell } from '../VerdictCell';
import { formatDate } from '../dateFormat';
import { formatScoreOutOf100, hasScore } from '../scoreFormat';
import { ComparabilityMark } from './CandidatesTable';
import { useIsPhone } from '../ResponsiveList';
import { LEVEL_MAX, cellLabel, cellStanding, cellTitle, comparisonPath } from './comparisonModel';
import type { ComparedCandidate, ComparisonPayload, GridCompetency } from './candidateRow';

/**
 * Two to four shortlisted candidates, read against each other.
 *
 * One column per person, one block per competency, so the eye runs across a
 * row rather than back and forth between pages. Each column carries what a
 * hiring decision actually turns on: the level, the reviewer's verdict where
 * there is one, the AI's where there is not, and the quotes the level was
 * drawn from — each linking to that candidate's own assessment, because a
 * quote out of its transcript is not evidence.
 */

const WITHHELD_TEXT = 'Record your own verdict for this candidate first. Their levels, score and the AI’s call stay hidden until then, so your reading is your own.';

function VerdictBlock({ candidate }: { candidate: ComparedCandidate }) {
  if (candidate.blindReviewPending) {
    return (
      <div className="cmp-sbs-verdict">
        <p className="muted small">{WITHHELD_TEXT}</p>
        {candidate.assessmentId && (
          <Link className="link-action" to={`/assessments/${candidate.assessmentId}/review`}>
            <Icon name="human-review" size={15} />Give your review
          </Link>
        )}
      </div>
    );
  }
  return (
    <div className="cmp-sbs-verdict">
      <VerdictCell row={candidate} />
      <span className={hasScore(candidate.overallScore) ? 'cmp-sbs-score' : 'cmp-sbs-score muted'}>
        {formatScoreOutOf100(candidate.overallScore)}
      </span>
      {candidate.assessmentId && (
        <Link className="link-action" to={`/assessments/${candidate.assessmentId}`}>
          <Icon name="evidence-review" size={15} />Open the assessment
        </Link>
      )}
    </div>
  );
}

function CompetencyCell({ candidate, competency }: { candidate: ComparedCandidate; competency: GridCompetency }) {
  const scored = candidate.competencies.find((c) => c.id === competency.id);
  const cell = scored?.cell ?? { kind: 'not_assessed' as const };
  const standing = cell.kind === 'level' ? cellStanding(cell.level, competency.requiredLevel) : null;
  return (
    <td className={standing ? `cmp-sbs-cell is-${standing}` : 'cmp-sbs-cell'}>
      <div className="cmp-sbs-level" title={cellTitle(cell, competency.name, competency.requiredLevel)}>
        {cell.kind === 'level'
          ? <><span className="cmp-level">{cell.level}</span><span className="muted small"> of {LEVEL_MAX}</span></>
          : <span className="cmp-cell-word">{cellLabel(cell)}</span>}
      </div>
      {scored?.evidence.map((e) => (
        <blockquote key={e.turnId + e.startMs} className="cmp-quote">
          {candidate.assessmentId
            ? <Link to={`/assessments/${candidate.assessmentId}#turn-${e.turnId}`}>{e.quote}</Link>
            : e.quote}
        </blockquote>
      ))}
    </td>
  );
}

/**
 * On a phone a three-column table is three columns of nothing. The same
 * comparison becomes one block per candidate, read by scrolling down rather
 * than sideways past the column that matters.
 */
function PhoneComparison({ candidates, competencies }: { candidates: readonly ComparedCandidate[]; competencies: readonly GridCompetency[] }) {
  return (
    <ul className="cmp-phone" aria-label="Shortlisted candidates compared">
      {candidates.map((c) => (
        <li key={c.id} className="cmp-phone-card" data-testid="side-by-side-card">
          <div className="cmp-phone-top">
            <Link to={`/candidates/${c.id}`}>{c.fullName}</Link>
            <span className="muted small">
              {c.stage ? c.stage.label : 'Not in the pipeline'}
              {c.stage?.outcome ? ` · ${c.stage.outcome}` : ''}
              {c.levelSource ? ` · ${c.levelSource === 'human' ? 'reviewer’s levels' : 'AI levels'}` : ''}
            </span>
            <ComparabilityMark notes={c.comparability} />
          </div>
          <VerdictBlock candidate={c} />
          {!c.blindReviewPending && (
            <dl className="cmp-phone-list">
              {competencies.map((competency) => {
                const scored = c.competencies.find((s) => s.id === competency.id);
                const cell = scored?.cell ?? { kind: 'not_assessed' as const };
                return (
                  <div key={competency.id} className="cmp-phone-line">
                    <dt>{competency.name}</dt>
                    <dd className={cell.kind === 'level' ? `is-${cellStanding(cell.level, competency.requiredLevel) ?? 'plain'}` : 'is-word'}>
                      {cellLabel(cell)}
                      {cell.kind === 'level' && <span className="muted small"> of {LEVEL_MAX}</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
          <p className="muted small">
            Next interview booked: {c.nextRoundAt ? formatDate(c.nextRoundAt) : 'Nothing booked'}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function SideBySide(props: {
  readonly roleId: string;
  readonly candidateIds: readonly string[];
  readonly onClose: () => void;
}) {
  const isPhone = useIsPhone();
  const [data, setData] = useState<ComparisonPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const key = props.candidateIds.join(',');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<ComparisonPayload>(comparisonPath(props.roleId, key.split(',')))
      .then((d) => { if (!cancelled) { setData(d); setError(''); } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not compare these candidates.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.roleId, key]);

  const candidates = data?.candidates ?? [];

  return (
    <section className="card cmp-sbs" aria-label="Candidates side by side">
      <div className="row spread">
        <h3 className="card-title"><Icon name="shortlist" size={16} />Side by side</h3>
        <button type="button" className="btn ghost sm" onClick={props.onClose}>
          <Icon name="close" size={15} />Close
        </button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {loading && <p className="muted small">Loading the comparison…</p>}

      {!loading && !error && candidates.length > 0 && isPhone && (
        <PhoneComparison candidates={candidates} competencies={data?.competencies ?? []} />
      )}

      {!loading && !error && candidates.length > 0 && !isPhone && (
        <>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Shortlisted candidates compared">
            <table className="cmp-sbs-table">
              <thead>
                <tr>
                  <th className="cmp-rowhead">Competency</th>
                  {candidates.map((c) => (
                    <th key={c.id} scope="col">
                      <Link to={`/candidates/${c.id}`}>{c.fullName}</Link>
                      <div className="muted small">
                        {c.stage ? c.stage.label : 'Not in the pipeline'}
                        {c.stage?.outcome ? ` · ${c.stage.outcome}` : ''}
                        {c.levelSource ? ` · ${c.levelSource === 'human' ? 'reviewer’s levels' : 'AI levels'}` : ''}
                      </div>
                      <ComparabilityMark notes={c.comparability} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="cmp-sbs-summary">
                  <th scope="row">Verdict and score</th>
                  {candidates.map((c) => <td key={c.id}><VerdictBlock candidate={c} /></td>)}
                </tr>
                {(data?.competencies ?? []).map((competency) => (
                  <tr key={competency.id}>
                    <th scope="row" className="cmp-rowhead">
                      {competency.name}
                      <span className="muted small cmp-col-need">needs {competency.requiredLevel}</span>
                    </th>
                    {candidates.map((c) => <CompetencyCell key={c.id} candidate={c} competency={competency} />)}
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="cmp-rowhead">Next interview booked</th>
                  {candidates.map((c) => (
                    <td key={c.id} className="muted small">
                      {c.nextRoundAt ? formatDate(c.nextRoundAt) : 'Nothing booked'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {!loading && !error && candidates.length > 0 && (
        <>
          {data?.availabilityRecorded === false && (
            <p className="muted small">
              Questor does not record a candidate’s notice period or availability, so there is nothing to compare on
              that here. The booked interview above is what it does hold.
            </p>
          )}
        </>
      )}
    </section>
  );
}
