import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
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
  candidateId: string;
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

interface SchedulingNotice {
  delivered: boolean;
  link: string;
  deliveryNote: string;
}

const STATE_TEXT: Record<StageState, string> = {
  done: 'Completed',
  current: 'Current stage',
  upcoming: 'Upcoming',
  decided: 'Decision made here',
  skipped: 'Not needed',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

function StageBadge({ stageKey }: { stageKey: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="pipeline-badge pipeline-badge-fallback" aria-hidden="true" />;
  return <img className="pipeline-badge" src={`/brand/medal-${stageKey}.png`} alt="" onError={() => setFailed(true)} />;
}

/**
 * The candidate's medallion pipeline: where they are, what happened, and what HR can do next.
 *
 * `onChanged` fires after any action that altered the pipeline, so a page
 * showing the same data elsewhere — the candidate journey board — refreshes
 * with it rather than sitting on a stale copy until someone reloads.
 */
export function PipelinePanel(
  { candidateId, interviews, onChanged }:
  { candidateId: string; interviews: InterviewOption[]; onChanged?: () => void },
) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Only the newest load may write state, so a slow response for a previously
  // viewed candidate can never replace this candidate's pipeline.
  const latestLoad = useRef(0);

  const [scheduledAt, setScheduledAt] = useState('');
  const [interviewers, setInterviewers] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [decision, setDecision] = useState<Decision>('APPROVED');
  const [reason, setReason] = useState('');
  const [roundToComplete, setRoundToComplete] = useState('');
  const [roundNotes, setRoundNotes] = useState('');
  const [schedulingNotice, setSchedulingNotice] = useState<SchedulingNotice | null>(null);

  const load = useCallback(async () => {
    const loadId = ++latestLoad.current;
    const { pipelines } = await api.get<{ pipelines: Pipeline[] }>(`/pipelines?candidateId=${encodeURIComponent(candidateId)}`);
    const current = pipelines[0] ?? null;
    const nextSummary = current ? (await api.get<{ summary: Summary }>(`/pipelines/${current.id}/summary`)).summary : null;
    if (loadId !== latestLoad.current) return;
    setPipeline(current);
    setSummary(nextSummary);
  }, [candidateId]);

  useEffect(() => {
    // A different candidate: drop the previous one's pipeline before anything can act on it.
    setPipeline(null);
    setSummary(null);
    setError('');
    setLoading(true);
    // load() claims the next id synchronously; a failure from an older load must
    // not set this candidate's error or loading state either.
    const loadId = latestLoad.current + 1;
    load()
      .catch((e: unknown) => { if (latestLoad.current === loadId) setError(errorMessage(e)); })
      .finally(() => { if (latestLoad.current === loadId) setLoading(false); });
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
      onChanged?.();
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="card pipeline">
        <h2 className="card-title"><Icon name="flag" />Hiring pipeline</h2>
        <Skeleton lines={3} label="Loading pipeline…" />
      </section>
    );
  }

  if (!pipeline || pipeline.candidateId !== candidateId) {
    return (
      <section className="card pipeline">
        <h2 className="card-title"><Icon name="flag" />Hiring pipeline</h2>
        {error && <Banner kind="error">{error}</Banner>}
        <EmptyState
          compact
          icon="flag"
          title="No pipeline yet"
          message="Track this candidate from onboarding through the Bronze profile review, the Silver AI interview and any human rounds, with a decision recorded by a person."
          action={
            <button className="btn" disabled={busy} onClick={() => run(() => api.post('/pipelines', { candidateId }))}>
              <Icon name={busy ? 'hourglass' : 'play'} size={16} />
              {busy ? 'Starting…' : 'Start pipeline'}
            </button>
          }
        />
      </section>
    );
  }

  const states = stageStates(pipeline.stages, pipeline.currentStageKey, pipeline.status);
  const current = pipeline.stages.find((s) => s.key === pipeline.currentStageKey);
  const next = nextStage(pipeline.stages, pipeline.currentStageKey);
  const labelFor = (key: string | null) => pipeline.stages.find((s) => s.key === key)?.label ?? key ?? '';
  const isInterviewStage = current?.kind === 'ai_interview' || current?.kind === 'human_interview';
  const openHumanRounds = pipeline.rounds.filter((r) => r.conductedBy === 'HUMAN' && r.status === 'SCHEDULED');

  const scheduleRound = (e: React.FormEvent) => {
    e.preventDefault();
    if (!current || !scheduledAt) return;
    const names = interviewers.split(',').map((n) => n.trim()).filter(Boolean);
    void run(() => api.post<{ notification?: SchedulingNotice }>(`/pipelines/${pipeline.id}/rounds`, {
      stageKey: current.key,
      scheduledAt: new Date(scheduledAt).toISOString(),
      ...(current.kind === 'ai_interview' && sessionId ? { sessionId } : {}),
      ...(current.kind === 'human_interview' && names.length > 0 ? { interviewers: names } : {}),
    }).then((resp) => {
      setSchedulingNotice(resp.notification ?? null);
      setScheduledAt('');
      setInterviewers('');
      setSessionId('');
    }));
  };

  const completeRound = (e: React.FormEvent) => {
    e.preventDefault();
    const roundId = roundToComplete || openHumanRounds[0]?.id;
    if (!roundId) return;
    void run(() => api.post(`/pipelines/${pipeline.id}/rounds/${roundId}/complete`, { notes: roundNotes })
      .then(() => { setRoundNotes(''); setRoundToComplete(''); }));
  };

  const recordDecision = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => api.post(`/pipelines/${pipeline.id}/decision`, { decision, reason }).then(() => setReason('')));
  };

  return (
    <section className="card pipeline">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h2 className="card-title" style={{ margin: 0 }}><Icon name="flag" />Hiring pipeline</h2>
        <StatusBadge kind="pipeline" value={pipeline.status} />
      </div>
      {error && <Banner kind="error">{error}</Banner>}

      {schedulingNotice && (
        <Banner kind={schedulingNotice.delivered ? 'ok' : 'info'}>
          Round scheduled. {schedulingNotice.deliveryNote} <a href={schedulingNotice.link}>{schedulingNotice.link}</a>
        </Banner>
      )}

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
          {/* Badge labels come from statusModel and match DECISION_TEXT. */}
          <StatusBadge kind="decision" value={pipeline.decision ?? 'APPROVED'} />{' '}
          at {labelFor(pipeline.decidedAtStageKey)}. {pipeline.decisionReason}
        </Banner>
      ) : (
        <div className="pipeline-actions grid cols-3">
          <div className="pipeline-action">
            <h3 className="card-title"><Icon name="arrow-right" size={16} />Next stage</h3>
            {next ? (
              <button className="btn secondary" disabled={busy} onClick={() => run(() => api.post(`/pipelines/${pipeline.id}/advance`, { toStageKey: next.key }))}>
                <Icon name="arrow-right" size={16} />Move to {next.label}
              </button>
            ) : (
              <p className="muted small">This is the final stage. Record a decision when ready.</p>
            )}
          </div>

          <form className="pipeline-action" onSubmit={scheduleRound}>
            <h3 className="card-title"><Icon name="schedule" size={16} />Schedule {current ? `${current.label} round` : 'round'}</h3>
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
                <button className="btn secondary" style={{ marginTop: 10 }} disabled={busy}><Icon name="schedule" size={16} />Schedule</button>
              </>
            ) : (
              <p className="muted small">{current?.label} is not an interview stage.</p>
            )}
          </form>

          <form className="pipeline-action" onSubmit={recordDecision}>
            <h3 className="card-title"><Icon name="check-circle" size={16} />Record decision</h3>
            <label htmlFor="decision">Outcome</label>
            <select id="decision" value={decision} onChange={(e) => setDecision(e.target.value as Decision)}>
              <option value="APPROVED">Approve</option>
              <option value="REJECTED">Do not progress</option>
              <option value="WITHDRAWN">Candidate withdrew</option>
            </select>
            <label htmlFor="decision-reason">Reason</label>
            <textarea id="decision-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required placeholder="What in the evidence led to this decision?" />
            <button className="btn" style={{ marginTop: 10 }} disabled={busy}><Icon name="check-circle" size={16} />Record decision</button>
          </form>
        </div>
      )}

      {pipeline.rounds.length > 0 && (
        <>
          <h3 className="card-title"><Icon name="schedule" size={16} />Rounds</h3>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Interview rounds">
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
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <StatusBadge kind="round" value={round.status} />
                      {round.conductedBy === 'AI' && round.sessionId && round.status === 'SCHEDULED' && (
                        <Link to={`/interviews/${round.sessionId}/observe`}><Icon name="eye" size={15} />Observe live</Link>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {openHumanRounds.length > 0 && (
        <form className="pipeline-action pipeline-complete" onSubmit={completeRound}>
          <h3 className="card-title"><Icon name="candidates" size={16} />Complete a human round</h3>
          <p className="muted small">What the interviewers recorded becomes the evidence for this stage.</p>
          {openHumanRounds.length > 1 && (
            <>
              <label htmlFor="complete-round">Round</label>
              <select id="complete-round" value={roundToComplete || openHumanRounds[0].id} onChange={(e) => setRoundToComplete(e.target.value)}>
                {openHumanRounds.map((round) => (
                  <option key={round.id} value={round.id}>{labelFor(round.stageKey)} · {new Date(round.scheduledAt).toLocaleString()}</option>
                ))}
              </select>
            </>
          )}
          <label htmlFor="round-notes">Round notes</label>
          <textarea id="round-notes" value={roundNotes} onChange={(e) => setRoundNotes(e.target.value)} minLength={20} required placeholder="What the candidate demonstrated, with specific examples." />
          <button className="btn secondary" style={{ marginTop: 10 }} disabled={busy}><Icon name="check" size={16} />Complete round</button>
        </form>
      )}

      {summary && (
        <div className="pipeline-summary">
          <h3 className="card-title"><Icon name="evidence" size={16} />Evidence so far</h3>
          <ul className="evidence-list">
            {summary.stages.map((stage) => (
              <li key={stage.key} className={stage.hasEvidence ? 'has-evidence' : 'no-evidence'}>
                <span className="evidence-mark" aria-hidden="true">{stage.hasEvidence ? <Icon name="check-circle" size={16} /> : '–'}</span>
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
