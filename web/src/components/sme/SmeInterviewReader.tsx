import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { formatDateTime } from '../dateFormat';
import { formatScoreOutOf100 } from '../scoreFormat';

interface Turn {
  id: string;
  index: number;
  speaker: string;
  text: string;
}

interface Competency {
  id: string;
  name: string;
  level: string | null;
  requiredLevel: string;
}

interface Assessment {
  id: string;
  scoredAt: string;
  overallScore: number | null;
  recommendation: string;
  summary: string;
  competencies: Competency[];
  strengths: string[];
  concerns: string[];
  openQuestions: string[];
  limitations: string[];
}

/**
 * One interview, as an expert reads it: what was said, and what the AI made of
 * it.
 *
 * Both are here because the expert is being asked for a second reading of the
 * same material, and a second reading of a summary is not one. The transcript
 * loads first and the AI's reading is behind a press, so the ordering on the
 * page is the ordering the work should happen in — though nothing enforces
 * that, because an expert asked to explain a disagreement has to be able to see
 * what they are disagreeing with.
 */
export function SmeInterviewReader({ candidateId, sessionId }: { candidateId: string; sessionId: string }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null | undefined>(undefined);
  const [showAssessment, setShowAssessment] = useState(false);
  const [error, setError] = useState('');

  const base = `/sme/candidates/${candidateId}/interviews/${sessionId}`;

  const loadTranscript = useCallback(async () => {
    try {
      const data = await api.get<{ transcript: Turn[] }>(`${base}/transcript`);
      setTurns(data.transcript ?? []);
      setError('');
    } catch (err: unknown) {
      // 409 is the live-interview gate, which is a state rather than a fault:
      // the candidate may still be speaking, and the transcript arrives when
      // they have finished.
      setError(err instanceof ApiError && err.status === 409
        ? 'The transcript is available once the interview has ended.'
        : err instanceof Error ? err.message : 'Could not load the transcript.');
      setTurns([]);
    }
  }, [base]);

  useEffect(() => {
    setTurns(null);
    setAssessment(undefined);
    setShowAssessment(false);
    void loadTranscript();
  }, [loadTranscript]);

  const loadAssessment = async () => {
    setShowAssessment(true);
    if (assessment !== undefined) return;
    try {
      const data = await api.get<{ assessment: Assessment | null }>(`${base}/assessment`);
      setAssessment(data.assessment);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load the assessment.');
      setAssessment(null);
    }
  };

  return (
    <>
      <div className="card">
        <h2 className="card-title"><Icon name="interviews" />What was said</h2>
        {error && <Banner kind="error">{error}</Banner>}
        {turns === null ? (
          <p className="muted small">Loading the transcript…</p>
        ) : turns.length === 0 ? (
          <p className="muted small">There is no transcript for this interview.</p>
        ) : (
          <ol className="transcript" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {turns.map((turn) => (
              <li key={turn.id} style={{ marginBottom: 12 }}>
                <div className="muted small">{turn.speaker}</div>
                <div>{turn.text}</div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="ai-interview" />What the AI made of it</h2>
        {!showAssessment ? (
          <>
            {/* Behind a press rather than open by default. An expert who has
                read the machine's conclusion first is no longer an independent
                reading of the same candidate, and the difference between the
                two is invisible afterwards. */}
            <p className="muted small">
              Hidden until you ask for it. Your reading is worth more to the hiring team if it is your own.
            </p>
            <button type="button" className="btn secondary sm" onClick={() => void loadAssessment()}>
              <Icon name="eye" size={14} />Show the AI's reading
            </button>
          </>
        ) : assessment === undefined ? (
          <p className="muted small">Loading…</p>
        ) : assessment === null ? (
          <p className="muted small">This interview has not been assessed.</p>
        ) : (
          <>
            <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
              <div><div className="muted small">Score</div><div>{formatScoreOutOf100(assessment.overallScore)}</div></div>
              <div><div className="muted small">Recommendation</div><div>{assessment.recommendation}</div></div>
              <div><div className="muted small">Scored</div><div>{formatDateTime(assessment.scoredAt)}</div></div>
            </div>
            {assessment.summary && <p style={{ marginTop: 12 }}>{assessment.summary}</p>}
            {assessment.competencies.length > 0 && (
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Competency readings">
                <table>
                  <thead><tr><th>Competency</th><th>Read at</th><th>Needed</th></tr></thead>
                  <tbody>
                    {assessment.competencies.map((competency) => (
                      <tr key={competency.id}>
                        <td>{competency.name}</td>
                        {/* Null is "not enough evidence", which is a finding
                            rather than a zero, and must not read as one. */}
                        <td>{competency.level ?? <span className="muted small">Not enough evidence</span>}</td>
                        <td className="muted small">{competency.requiredLevel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {assessment.limitations.length > 0 && (
              <p className="muted small" style={{ marginTop: 12 }}>
                What the machine says it could not tell: {assessment.limitations.join('; ')}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
