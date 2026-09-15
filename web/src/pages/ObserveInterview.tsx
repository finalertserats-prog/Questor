import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';

interface ObservedTurn {
  index: number;
  speaker: 'agent' | 'candidate' | 'system';
  text: string;
  createdAt: string;
}

interface ObserveResp {
  session: { id: string; state: string };
  turns: ObservedTurn[];
}

const POLL_MS = 3000;

// Once an interview reaches one of these there is nothing left to watch.
const FINISHED = new Set([
  'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED', 'CANCELLED', 'NO_SHOW', 'CANDIDATE_WITHDREW',
  'TECHNICAL_FAILURE', 'POLICY_STOP', 'MANUAL_HANDOFF', 'INCOMPLETE',
]);

const SPEAKER: Record<ObservedTurn['speaker'], string> = {
  agent: 'Schranders',
  candidate: 'Candidate',
  system: 'System',
};

/**
 * HR watching the AI interview live. Read-only by design: there is no way to
 * type, speak or otherwise reach the candidate from this page.
 */
export function ObserveInterview() {
  const { id = '' } = useParams();
  const [data, setData] = useState<ObserveResp | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const next = await api.get<ObserveResp>(`/interviews/${encodeURIComponent(id)}/observe`);
        if (!active) return;
        setData(next);
        setError('');
        if (!FINISHED.has(next.session.state)) timer = window.setTimeout(poll, POLL_MS);
      } catch (e: unknown) {
        if (active) setError(e instanceof Error ? e.message : 'Could not load the interview.');
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id]);

  const finished = data ? FINISHED.has(data.session.state) : false;

  return (
    <div>
      <div className="topbar">
        <h1>Observing interview</h1>
        <Link className="btn secondary" to={`/interviews/${id}`}>Interview details</Link>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {data && (
        <>
          <Banner kind="info">
            You are observing silently. The candidate was told a member of the hiring team may observe, and nothing you do here reaches them.
          </Banner>
          <div className="card">
            <div className="row spread" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>Live transcript</h2>
              <span className="muted small">{finished ? 'Interview finished' : 'Updating every few seconds'}</span>
            </div>
            {data.turns.length === 0 ? (
              <p className="muted small">The interview has not started yet.</p>
            ) : (
              <ol className="observe-transcript" aria-live="polite">
                {data.turns.map((turn) => (
                  <li key={turn.index} className={`observe-turn observe-${turn.speaker}`}>
                    <span className="observe-speaker">{SPEAKER[turn.speaker]}</span>
                    <span>{turn.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}
