import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { nextStage, stageCaption, stageStates, type PipelineStageView, type StageState } from './pipelineView';
import { decisionStatus, interviewStatus } from './statusModel';
import { sessionOptionLabels } from './roleLabelModel';
import { interviewerName } from './candidateJourney';
import { formatDateTime } from './dateFormat';
import { RoundActions, RoundMeeting } from './RoundMeeting';
import {
  meetingLinkProblem, safeMeetingUrl, scheduleHint,
  type MeetingOutcome, type MeetingProviderInfo, type RoundMeetingView,
} from './roundMeetingModel';

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
  /** Absent on an older server; null for AI rounds. */
  meeting?: RoundMeetingView | null;
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
  /** The AI interviewer's name for that session; absent on an older server. */
  personaName?: string | null;
}

type Decision = 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

/** The server's own floor for a decision reason, checked here too. */
const MIN_DECISION_REASON = 10;

interface SchedulingNotice {
  delivered: boolean;
  link: string;
  deliveryNote: string;
}

const DURATIONS = [30, 45, 60, 90] as const;

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
  { candidateId, candidateName, interviews, onChanged }:
  { candidateId: string; candidateName: string; interviews: InterviewOption[]; onChanged?: () => void },
) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A failed load is kept apart from a failed action: with no pipeline read,
  // the panel cannot tell "none yet" from "could not ask", so it must not offer
  // to start one.
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
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
  const [meetingLink, setMeetingLink] = useState('');
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [meetingNotice, setMeetingNotice] = useState<MeetingOutcome | null>(null);
  const [meetingProvider, setMeetingProvider] = useState<MeetingProviderInfo | null>(null);
  // Set while a candidacy-ending outcome waits to be confirmed.
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);
  // The stage a move is waiting to be confirmed for.
  const [pendingAdvance, setPendingAdvance] = useState<string | null>(null);

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
    setLoadError('');
    setLoading(true);
    // load() claims the next id synchronously; a failure from an older load must
    // not set this candidate's error or loading state either.
    const loadId = latestLoad.current + 1;
    load()
      .catch((e: unknown) => { if (latestLoad.current === loadId) setLoadError(errorMessage(e)); })
      .finally(() => { if (latestLoad.current === loadId) setLoading(false); });
  }, [load, reloadKey]);

  // Which provider will create links for human rounds. Only read by people who
  // can schedule; without it the form simply asks for a link.
  useEffect(() => {
    let cancelled = false;
    api.get<{ meetingProvider: MeetingProviderInfo }>('/pipelines/meeting-provider')
      .then((resp) => { if (!cancelled) setMeetingProvider(resp.meetingProvider); })
      .catch(() => { if (!cancelled) setMeetingProvider(null); });
    return () => { cancelled = true; };
  }, []);

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

  if (loadError && (!pipeline || pipeline.candidateId !== candidateId)) {
    return (
      <section className="card pipeline">
        <h2 className="card-title"><Icon name="flag" />Hiring pipeline</h2>
        <Banner kind="error">Could not load this candidate&rsquo;s pipeline. {loadError}</Banner>
        <button type="button" className="btn secondary" onClick={() => setReloadKey((k) => k + 1)}>
          <Icon name="refresh" size={16} />Try again
        </button>
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
    // A round in the past is almost always a mistyped date, and it reaches the
    // candidate as an invitation to a time that has already gone.
    if (new Date(scheduledAt).getTime() < Date.now()) {
      setError('That time has already passed. Pick a date and time in the future.');
      return;
    }
    const names = interviewers.split(',').map((n) => n.trim()).filter(Boolean);
    const human = current.kind === 'human_interview';
    const link = meetingLink.trim();
    const linkProblem = human && link ? meetingLinkProblem(link) : null;
    if (linkProblem) {
      setError(linkProblem);
      return;
    }
    void run(() => api.post<{ notification?: SchedulingNotice; meeting?: MeetingOutcome | null }>(`/pipelines/${pipeline.id}/rounds`, {
      stageKey: current.key,
      scheduledAt: new Date(scheduledAt).toISOString(),
      ...(current.kind === 'ai_interview' && sessionId ? { sessionId } : {}),
      ...(human && names.length > 0 ? { interviewers: names } : {}),
      ...(human ? { durationMinutes } : {}),
      ...(human && link ? { meetingUrl: link } : {}),
    }).then((resp) => {
      setSchedulingNotice(resp.notification ?? null);
      setMeetingNotice(resp.meeting ?? null);
      setScheduledAt('');
      setInterviewers('');
      setSessionId('');
      setMeetingLink('');
    }));
  };

  const completeRound = (e: React.FormEvent) => {
    e.preventDefault();
    const roundId = roundToComplete || openHumanRounds[0]?.id;
    if (!roundId) return;
    void run(() => api.post(`/pipelines/${pipeline.id}/rounds/${roundId}/complete`, { notes: roundNotes })
      .then(() => { setRoundNotes(''); setRoundToComplete(''); }));
  };

  const submitDecision = () => {
    // Trimmed and checked here, not only by the browser: this reason is the
    // record of why someone's candidacy ended.
    if (reason.trim().length < MIN_DECISION_REASON) {
      setError(`Say why in at least ${MIN_DECISION_REASON} characters — this is the record of the decision.`);
      return;
    }
    void run(() => api.post(`/pipelines/${pipeline.id}/decision`, { decision, reason: reason.trim() })
      .then(() => { setReason(''); setPendingDecision(null); }));
  };

  // Approving moves someone forward; the other two end their candidacy and
  // close the pipeline, and nothing in this panel undoes that. Those two get
  // named back — outcome and person — before they are recorded.
  const recordDecision = (e: React.FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < MIN_DECISION_REASON) {
      setError(`Say why in at least ${MIN_DECISION_REASON} characters — this is the record of the decision.`);
      return;
    }
    if (decision === 'APPROVED') { submitDecision(); return; }
    setPendingDecision(decision);
  };

  // Moving someone on is visible to them and to the next interviewer, and the
  // button sits beside the stage track where a stray click lands easily.
  const advance = () => {
    if (!next) return;
    if (pendingAdvance !== next.key) { setPendingAdvance(next.key); return; }
    setPendingAdvance(null);
    void run(() => api.post(`/pipelines/${pipeline.id}/advance`, { toStageKey: next.key }));
  };

  return (
    <section className="card pipeline">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h2 className="card-title" style={{ margin: 0 }}><Icon name="flag" />Hiring pipeline</h2>
        <StatusBadge kind="pipeline" value={pipeline.status} />
      </div>
      {error && <Banner kind="error">{error}</Banner>}

      {meetingNotice && (
        <Banner kind={meetingNotice.ok ? 'ok' : 'error'}>
          {meetingNotice.message}{' '}
          {safeMeetingUrl(meetingNotice.url) && (
            <a href={safeMeetingUrl(meetingNotice.url) ?? undefined} target="_blank" rel="noopener noreferrer">Join link</a>
          )}
          {!meetingNotice.ok && meetingNotice.status === 'NEEDS_LINK' && ' Use "Try again" or "Add link manually" in the rounds table below.'}
        </Banner>
      )}

      {schedulingNotice && (
        <Banner kind={schedulingNotice.delivered ? 'ok' : 'info'}>
          Round scheduled. {schedulingNotice.deliveryNote}{' '}
          {safeMeetingUrl(schedulingNotice.link)
            ? <a className="break-anywhere" href={safeMeetingUrl(schedulingNotice.link) ?? undefined} target="_blank" rel="noopener noreferrer">{schedulingNotice.link}</a>
            : <span className="break-anywhere">{schedulingNotice.link}</span>}
        </Banner>
      )}

      <ol className="stage-track">
        {pipeline.stages.map((stage, index) => (
          <li key={stage.key} className={`pipeline-stage stage-${states[index]}`} aria-current={states[index] === 'current' ? 'step' : undefined}>
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
              <>
                <button type="button" className="btn secondary" disabled={busy} onClick={advance}>
                  <Icon name="arrow-right" size={16} />
                  {pendingAdvance === next.key ? `Confirm move to ${next.label}` : `Move to ${next.label}`}
                </button>
                {pendingAdvance === next.key && (
                  <p className="muted small" style={{ marginTop: 6 }}>
                    {candidateName} moves to {next.label}.{' '}
                    <button type="button" className="btn ghost sm" onClick={() => setPendingAdvance(null)}>Not yet</button>
                  </p>
                )}
              </>
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
                      {/* Date and time, so two sessions set up the same day differ. */}
                      {sessionOptionLabels(interviews.map((iv) => ({ id: iv.id, createdAt: iv.createdAt, text: interviewStatus(iv.state).label })))
                        .map((label, index) => <option key={interviews[index].id} value={interviews[index].id}>{label}</option>)}
                    </select>
                  </>
                ) : (
                  <>
                    <label htmlFor="round-people">Interviewers</label>
                    <input id="round-people" value={interviewers} onChange={(e) => setInterviewers(e.target.value)} placeholder="Hiring manager, Team lead" />
                    <label htmlFor="round-length">Length</label>
                    <select id="round-length" value={durationMinutes} onChange={(e) => setDurationMinutes(Number(e.target.value))}>
                      {DURATIONS.map((d) => <option key={d} value={d}>{d} minutes</option>)}
                    </select>
                    <p className="muted small" data-testid="meeting-provider-hint">{scheduleHint(meetingProvider)}</p>
                    <label htmlFor="round-link">Meeting link (optional)</label>
                    <input id="round-link" type="url" inputMode="url" value={meetingLink} onChange={(e) => setMeetingLink(e.target.value)} placeholder="https://…" />
                  </>
                )}
                <button className="btn secondary" style={{ marginTop: 10 }} disabled={busy}><Icon name="schedule" size={16} />Schedule</button>
              </>
            ) : (
              <p className="muted small">{current?.label} is not an interview stage.</p>
            )}
          </form>

          <form className="pipeline-action" onSubmit={recordDecision}>
            <h3 className="card-title"><Icon name="decision" size={16} />Record decision</h3>
            <label htmlFor="decision">Outcome</label>
            <select
              id="decision"
              value={decision}
              onChange={(e) => { setDecision(e.target.value as Decision); setPendingDecision(null); }}
            >
              <option value="APPROVED">Approve</option>
              <option value="REJECTED">Do not progress</option>
              <option value="WITHDRAWN">Candidate withdrew</option>
            </select>
            <label htmlFor="decision-reason">Reason</label>
            <textarea id="decision-reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} required placeholder="What in the evidence led to this decision?" />
            <button className="btn" style={{ marginTop: 10 }} disabled={busy}><Icon name="check-circle" size={16} />Record decision</button>
            {pendingDecision && (
              <Banner kind="info">
                Record <b>{decisionStatus(pendingDecision).label.toLowerCase()}</b> for {candidateName}?
                This closes their pipeline and is recorded against your name.
                <div className="row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn" disabled={busy} onClick={submitDecision}>
                    <Icon name="check-circle" size={16} />Yes, record it
                  </button>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => setPendingDecision(null)}>
                    Cancel
                  </button>
                </div>
              </Banner>
            )}
          </form>
        </div>
      )}

      {pipeline.rounds.length > 0 && (
        <>
          <h3 className="card-title"><Icon name="schedule" size={16} />Rounds</h3>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Interview rounds">
          <table>
            <thead>
              <tr><th>Stage</th><th>Led by</th><th>Observers</th><th>Scheduled</th><th>Status</th><th>Meeting</th><th scope="col" aria-label="Manage round" /></tr>
            </thead>
            <tbody>
              {pipeline.rounds.map((round) => (
                <tr key={round.id}>
                  <td>{labelFor(round.stageKey)}</td>
                  {/* The persona is configurable per interview, so the name
                      comes from the session rather than from this file. */}
                  <td>
                    {round.conductedBy === 'AI'
                      ? `AI (${interviewerName(interviews.find((iv) => iv.id === round.sessionId)?.personaName)})`
                      : round.interviewers.join(', ') || 'Human interviewer'}
                  </td>
                  <td className="muted small">{round.hrMayObserve ? 'HR may observe' : round.aiObserver ? 'AI observer' : '—'}</td>
                  <td>{formatDateTime(round.scheduledAt)}</td>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <StatusBadge kind="round" value={round.status} />
                      {round.conductedBy === 'AI' && round.sessionId && round.status === 'SCHEDULED' && (
                        <Link to={`/interviews/${round.sessionId}/observe`}><Icon name="eye" size={15} />Observe live</Link>
                      )}
                      {round.conductedBy === 'HUMAN' && round.aiObserver && (
                        <Link to={`/rounds/${round.id}/observer`}>
                          <Icon name="captions" size={15} />{round.status === 'SCHEDULED' ? 'Observer room' : 'Transcript & quotes'}
                        </Link>
                      )}
                    </span>
                  </td>
                  <td>
                    <RoundMeeting
                      pipelineId={pipeline.id} round={round} busy={busy} run={run}
                      onOutcome={setMeetingNotice} onError={setError}
                      vendorReady={meetingProvider !== null && meetingProvider.provider !== 'manual' && meetingProvider.configured}
                    />
                  </td>
                  <td>
                    <RoundActions
                      pipelineId={pipeline.id} round={round} busy={busy} run={run}
                      onOutcome={setMeetingNotice} onError={setError}
                      canReschedule={pipeline.status === 'ACTIVE'}
                    />
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
          <h3 className="card-title"><Icon name="human-review" size={16} />Complete a human round</h3>
          <p className="muted small">What the interviewers recorded becomes the evidence for this stage.</p>
          {openHumanRounds.length > 1 && (
            <>
              <label htmlFor="complete-round">Round</label>
              <select id="complete-round" value={roundToComplete || openHumanRounds[0].id} onChange={(e) => setRoundToComplete(e.target.value)}>
                {openHumanRounds.map((round) => (
                  <option key={round.id} value={round.id}>{labelFor(round.stageKey)} · {formatDateTime(round.scheduledAt)}</option>
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
