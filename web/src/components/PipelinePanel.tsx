import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { nextStage, stageCaption, stageStates, type PipelineStageView, type StageState } from './pipelineView';

interface Round {
  id: string;
  stageKey: string;
  conductedBy: 'AI' | 'HUMAN';
  aiObserver: boolean;
  hrMayObserve: boolean;
  sessionId: string | null;
  interviewers: string[];
  scheduledAt: string;
  status: string;
}

interface Pipeline {
  id: string;
  stages: PipelineStageView[];
  currentStageKey: string;
  status: 'ACTIVE' | 'DECIDED';
  decision: string | null;
  decisionReason: string | null;
  decidedAtStageKey: string | null;
  rounds: Round[];
}

interface StageSummary extends PipelineStageView {
  hasEvidence: boolean;
  detail: string;
}

interface Summary {
  stages: StageSummary[];
  missingEvidence: string[];
  note: string;
}

interface InterviewOption {
  id: string;
  state: string;
  createdAt: string;
}

type Decision = 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

const STATE_TEXT: Record<StageState, string> = {
  done: 'Completed',
  current: 'Current stage',
  upcoming: 'Upcoming',
  decided: 'Decision made here',
  skipped: 'Not needed',
};

const DECISION_TEXT: Record<Decision, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Not progressing',
  WITHDRAWN: 'Withdrawn',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

function StageBadge({ stageKey }: { stageKey: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="pipeline-badge pipeline-badge-fallback" aria-hidden="true" />;
  return <img className="pipeline-badge" src={`/brand/medal-${stageKey}.png`} alt="" onError={() => setFailed(true)} />;
}

/** The candidate's medallion pipeline: where they are, what happened, and what HR can do next. */
export function PipelinePanel({ candidateId, interviews }: { candidateId: string; interviews: InterviewOption[] }) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [scheduledAt, setScheduledAt] = useState('');
  const [interviewers, setInterviewers] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [decision, setDecision] = useState<Decision>('APPROVED');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const { pipelines } = await api.get<{ pipelines: Pipeline[] }>(`/pipelines?candidateId=${encodeURIComponent(candidateId)}`);
    const current = pipelines[0] ?? null;
    setPipeline(current);
    setSummary(current ? (await api.get<{ summary: Summary }>(`/pipelines/${current.id}/summary`)).summary : null);
  }, [candidateId]);

  useEffect(() => {
    load().catch((e: unknown) => setError(errorMessage(e))).finally(() => setLoading(false));
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="card muted">Loading pipeline…</div>;

  if (!pipeline) {
    return (
      <section className="card pipeline">
        <h2>Hiring pipeline</h2>
        {error && <Banner kind="error">{error}</Banner>}
        <p className="muted small">
          Track this candidate from onboarding through the Bronze profile review, the Silver AI interview and any human rounds, with a decision recorded by a person.
        </p>
        <button className="btn" disabled={busy} onClick={() => run(() => api.post('/pipelines', { candidateId }))}>
          {busy ? 'Starting…' : 'Start pipeline'}
        </button>
      </section>
    );
  }

  const states = stageStates(pipeline.stages, pipeline.currentStageKey, pipeline.status);
  const current = pipeline.stages.find((s) => s.key === pipeline.currentStageKey);
  const next = nextStage(pipeline.stages, pipeline.currentStageKey);
  const labelFor = (key: string | null) => pipeline.stages.find((s) => s.key === key)?.label ?? key ?? '';
  const isInterviewStage = current?.kind === 'ai_interview' || current?.kind === 'human_interview';

  const scheduleRound = (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !scheduledAt) return;
    const names = interviewers.split(',').map((n) => n.trim()).filter(Boolean);
    void run(() => api.post(`/pipelines/${pipeline.id}/rounds`, {
      stageKey: current.key,
      scheduledAt: new Date(scheduledAt).toISOString(),
      ...(current.kind === 'ai_interview' && sessionId ? { sessionId } : {}),
      ...(current.kind === 'human_interview' && names.length > 0 ? { interviewers: names } : {}),
    }).then(() => { setScheduledAt(''); setInterviewers(''); setSessionId(''); }));
  };

  const recordDecision = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => api.post(`/pipelines/${pipeline.id}/decision`, { decision, reason }).then(() => setReason('')));
  };

  return (
    <section className="card pipeline">
      <h2>Hiring pipeline</h2>
      {error && <Banner kind="error">{error}</Banner>}

      <ol className="stage-track">
        {pipeline.stages.map((stage, index) => (
          <li key={stage.key} className={`stage stage-${states[index]}`} aria-current={states[index] === 'current' ? 'step' : undefined}>
            <StageBadge stageKey={stage.key} />
            <span className="stage-label">{stage.label}</span>
            <span className="stage-caption">{stageCaption(stage.kind)}</span>
            <span className="stage-state">{STATE_TEXT[states[index]]}</span>
          </li>
        ))}
      </ol>

      {pipeline.status === 'DECIDED' ? (
        <Banner kind="info">
          <b>{DECISION_TEXT[(pipeline.decision ?? 'APPROVED') as Decision]}</b> at {labelFor(pipeline.decidedAtStageKey)}. {pipeline.decisionReason}
        </Banner>
      ) : (
        <div className="pipeline-actions grid cols-3">
          <div className="pipeline-action">
            <h3>Next stage</h3>
            {next ? (
              <button className="btn secondary" disabled={busy} onClick={() => run(() => api.post(`/pipelines/${pipeline.id}/advance`, { toStageKey: next.key }))}>
                Move to {next.label}
              </button>
            ) : (
              <p className="muted small">This is the final stage. Record a decision when ready.</p>
            )}
          </div>

          <form className="pipeline-action" onSubmit={scheduleRound}>
            <h3>Schedule {current ? `${current.label} round` : 'round'}</h3>
            {isInterviewStage ? (
              <>
                <label htmlFor="round-when">Date and time</label>
                <input id="round-when" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} required />
                {current?.kind === 'ai_interview' ? (
                  <>
                    <label htmlFor="round-session">AI interview</label>
                    <select id="round-session" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                      <option value="">Link one later</option>
                      {interviews.map((iv) => (
                        <option key={iv.id} value={iv.id}>{new Date(iv.createdAt).toLocaleDateString()} · {iv.state}</option>
                      ))}
                    </select>
                  </>
                ) : (
                  <>
                    <label htmlFor="round-people">Interviewers</label>
                    <input id="round-people" value={interviewers} onChange={(e) => setInterviewers(e.target.value)} placeholder="Hiring manager, Team lead" />
                  </>
                )}
                <button className="btn secondary" style={{ marginTop: 10 }} disabled={busy}>Schedule</button>
              </>
            ) : (
              <p className="muted small">{current?.label} is not an interview stage.</p>
            )}
          </form>

          <form className="pipeline-action" onSubmit={recordDecision}>
            <h3>Record decision</h3>
            <label htmlFor="decision">Outcome</label>
            <select id="decision" value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
              <option value="APPROVED">Approve</option>
              <option value="REJECTED">Do not progress</option>
              <option value="WITHDRAWN">Candidate withdrew</option>
            </select>
            <label htmlFor="decision-reason">Reason</label>
            <textarea id="decision-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required placeholder="What in the evidence led to this decision?" />
            <button className="btn" style={{ marginTop: 10 }} disabled={busy}>Record decision</button>
          </form>
        </div>
      )}

      {pipeline.rounds.length > 0 && (
        <>
          <h3>Rounds</h3>
          <table>
            <thead>
              <tr><th>Stage</th><th>Led by</th><th>Observers</th><th>Scheduled</th><th>Status</th></tr>
            </thead>
            <tbody>
              {pipeline.rounds.map((round) => (
                <tr key={round.id}>
                  <td>{labelFor(round.stageKey)}</td>
                  <td>{round.conductedBy === 'AI' ? 'AI (Schranders)' : round.interviewers.join(', ') || 'Human interviewer'}</td>
                  <td className="muted small">{round.hrMayObserve ? 'HR may observe' : round.aiObserver ? 'AI observer' : '—'}</td>
                  <td>{new Date(round.scheduledAt).toLocaleString()}</td>
                  <td>{round.status.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {summary && (
        <div className="pipeline-summary">
          <h3>Evidence so far</h3>
          <ul className="evidence-list">
            {summary.stages.map((stage) => (
              <li key={stage.key} className={stage.hasEvidence ? 'has-evidence' : 'no-evidence'}>
                <span className="evidence-mark" aria-hidden="true">{stage.hasEvidence ? '✓' : '–'}</span>
                <b>{stage.label}</b> <span className="muted small">{stage.detail}</span>
              </li>
            ))}
          </ul>
          <p className="muted small">{summary.note}</p>
        </div>
      )}
    </section>
  );
}
