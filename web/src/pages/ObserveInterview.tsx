import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { observeLoadProblem } from '../components/observerModel';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { POLL_DELAY_MS, nextPollDelay } from '../components/pollBackoff';
import { interviewerName } from '../components/candidateJourney';

interface ObservedTurn {
  index: number;
  speaker: 'agent' | 'candidate' | 'system';
  text: string;
  createdAt: string;
}

interface ObserveResp {
  session: { id: string; state: string };
  /** Who conducted this interview; absent on an older server. */
  persona?: { name: string | null } | null;
  turns: ObservedTurn[];
}

// Once an interview reaches one of these there is nothing left to watch.
const FINISHED = new Set([
  'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED', 'CANCELLED', 'NO_SHOW', 'CANDIDATE_WITHDREW',
  'TECHNICAL_FAILURE', 'POLICY_STOP', 'MANUAL_HANDOFF', 'INCOMPLETE',
]);

// The agent's name is the one this session was conducted under, not a constant:
// a tenant that names its interviewer differently was being shown a name the
// candidate never heard.
function speakerName(speaker: ObservedTurn['speaker'], interviewer: string): string {
  if (speaker === 'agent') return interviewer;
  return speaker === 'candidate' ? 'Candidate' : 'System';
}

/**
 * HR watching the AI interview live. Read-only by design: there is no way to
 * type, speak or otherwise reach the candidate from this page.
 */
export function ObserveInterview() {
  const { id = '' } = useParams();
  const [data, setData] = useState<ObserveResp | null>(null);
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState('');

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    // Grows while the server is failing, resets the moment it answers.
    let delay = POLL_DELAY_MS;

    const poll = async () => {
      try {
        const next = await api.get<ObserveResp>(`/interviews/${encodeURIComponent(id)}/observe`);
        if (!active) return;
        setData(next);
        setError('');
        setWaiting('');
        delay = POLL_DELAY_MS;
        if (!FINISHED.has(next.session.state)) timer = window.setTimeout(poll, delay);
      } catch (e: unknown) {
        if (!active) return;
        const message = e instanceof Error ? e.message : 'Could not load the interview.';
        if (observeLoadProblem(e instanceof ApiError ? e.status : undefined) === 'waiting') { setWaiting(message); setError(''); }
        else { setError(message); setWaiting(''); }
        // A failed poll used to end the polling silently while the page still
        // claimed to be updating, so an observer watched a transcript that had
        // quietly stopped. Keep asking, less often each time.
        delay = nextPollDelay(delay);
        timer = window.setTimeout(poll, delay);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [id]);

  const finished = data ? FINISHED.has(data.session.state) : false;
  const interviewer = interviewerName(data?.persona?.name);

  return (
    <div>
      <PageHeader
        icon="eye"
        title="Observing interview"
        actions={<Link className="btn secondary" to={`/interviews/${id}`}><Icon name="arrow-left" size={16} />Interview details</Link>}
      />

      {error && <Banner kind="error">{error}</Banner>}
      {waiting && <Banner kind="info">{waiting} This page checks again on its own.</Banner>}

      {!data && !error && <div className="card"><Skeleton lines={5} label="Connecting to the live transcript…" /></div>}

      {data && (
        <>
          <Banner kind="info">
            You are observing silently. The candidate was told a member of the hiring team may observe, and nothing you do here reaches them.
          </Banner>
          <div className="card">
            <div className="row spread" style={{ marginBottom: 8 }}>
              <h2 className="card-title" style={{ margin: 0 }}><Icon name="interviews" />Live transcript</h2>
              {/* Says what is actually happening. While the polling is failing
                  this used to read "Updating every few seconds" over a
                  transcript that had stopped updating altogether. */}
              <span className="muted small card-title">
                <Icon name={finished ? 'check-circle' : error ? 'alert' : 'refresh'} size={14} />
                {finished ? 'Interview finished' : error ? 'Not updating — retrying' : 'Updating every few seconds'}
              </span>
            </div>
            {data.turns.length === 0 ? (
              <EmptyState compact icon="hourglass" title="Waiting to start" message="The interview has not started yet." />
            ) : (
              <ol className="observe-transcript" aria-live="polite">
                {data.turns.map((turn) => (
                  <li key={turn.index} className={`observe-turn observe-${turn.speaker}`}>
                    <span className="observe-speaker">{speakerName(turn.speaker, interviewer)}</span>
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
