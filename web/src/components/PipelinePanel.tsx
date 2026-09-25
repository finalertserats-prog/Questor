import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { StatusBadge } from './StatusBadge';
import { EmptyState } from './EmptyState';
import { Skeleton } from './Skeleton';
import { finalStage, nextStage, pipelineOutcome, stageCaption, stageStates, type PipelineStageView, type StageState } from './pipelineView';
import { decisionStatus, interviewStatus } from './statusModel';
import { sessionOptionLabels } from './roleLabelModel';
import { interviewerName } from './candidateJourney';
import { formatScheduled } from './dateFormat';
import { EMPTY_SCHEDULE, TimeZoneDateTimePicker } from './TimeZoneDateTimePicker';
import { browserTimeZone, schedulePreview, scheduleRequest, type ScheduleDraft } from './zonedScheduleModel';
import { useOrgTimeZoneStatus } from './useOrgTimeZone';
import { useCandidateTimeZone } from './useCandidateTimeZone';
import { orgTimeZoneLoadNotice } from './orgTimeZone';
import { RoundActions, RoundMeeting } from './RoundMeeting';
import { useAuth } from '../auth';
import { can, onlyWhoCan } from './capabilityModel';
import {
  meetingLinkProblem, safeMeetingUrl, scheduleHint,
  type CandidateNotice, type MeetingOutcome, type MeetingProviderInfo, type RoundMeetingView,
} from './roundMeetingModel';
import { useToast } from './Toast';

export interface Round {
  id: string;
  stageKey: string;
  conductedBy: 'AI' | 'HUMAN';
  aiObserver: boolean;
  hrMayObserve: boolean;
  sessionId: string | null;
  interviewers: string[];
  /** The colleagues conducting it, as Questor users. Absent on an older server. */
  panel?: Array<{ userId: string; name: string; seat: string }>;
  scheduledAt: string;
  /** The zone it was booked in; null or absent when booked without one. */
  scheduledTimeZone?: string | null;
  status: string;
  /** What the interviewer recorded; '' before the round is closed. */
  notes?: string;
  /** Why the record is not shown to this reader; '' when nothing is withheld. */
  notesWithheld?: string;
  /** What the round holds, so the page never implies a transcript it lacks. */
  evidence?: { kind: string; label: string; detail: string };
  /** Claims filed by competency, each with the words it rests on. */
  evidenceEntries?: Array<{ competencyId: string; competencyName: string; claim: string; quote: string }>;
  recordedBy?: { userId: string; name: string } | null;
  /**
   * Why this round cannot go ahead, when it cannot: somebody who would be in
   * the room has not agreed to it being recorded, and every human round is
   * recorded. Null in the ordinary case, and absent on an older server.
   */
  observerBlocked?: { reason: string; nextSteps: string[] } | null;
  /**
   * What the recording actually got. A fact about the recording — never about
   * the candidate, and never about the interviewer: a headset that stopped the
   * candidate's voice reaching the device is nobody's fault, and wording it as
   * one is how people stop reporting it.
   */
  captureReport?: { coverage: string; sentence: string } | null;
  /** Absent on an older server; null for AI rounds. */
  meeting?: RoundMeetingView | null;
}

interface TeamInterviewer {
  id: string;
  name: string;
  role: string;
}

interface Competency {
  id: string;
  name: string;
}

/** One competency the interviewer is speaking to, and the words the claim rests on. */
export interface EvidenceDraft {
  competencyId: string;
  claim: string;
  quote: string;
}

/**
 * The entries to send with the round.
 *
 * Only the rows the interviewer never touched are dropped — the form offers
 * every competency and most rounds reach some of them, so an untouched row is
 * the ordinary case. A HALF-written row is kept, deliberately, even though the
 * server will refuse it.
 *
 * Dropping half a row instead would lose evidence silently: closing a round is
 * one-shot (SCHEDULED to COMPLETED, and the route refuses a second attempt), so
 * a competency quietly omitted because the interviewer tabbed away mid-row is
 * omitted for good, and they would be looking at a round that closed
 * successfully. A refusal they have to fix is the better failure, and
 * `completeRound` stops the submission before it reaches the server at all.
 */
export function readyEntries(draft: readonly EvidenceDraft[]): EvidenceDraft[] {
  return draft.filter((entry) => entry.claim.trim().length > 0 || entry.quote.trim().length > 0);
}

/**
 * What to tell an interviewer who wrote a claim but no quote, or the reverse.
 *
 * Silence would be worse than a refusal: they would press Complete, watch the
 * round close, and never learn that the competency they typed into was dropped.
 */
export function evidenceDraftWarning(draft: readonly EvidenceDraft[], competencies: readonly Competency[]): string {
  const half = draft.filter((entry) => {
    const claim = entry.claim.trim().length > 0;
    const quote = entry.quote.trim().length > 0;
    return claim !== quote;
  });
  if (half.length === 0) return '';
  const names = half
    .map((entry) => competencies.find((c) => c.id === entry.competencyId)?.name ?? entry.competencyId)
    .join(', ');
  return `${names}: a claim needs the words it rests on, and a quote needs the claim it supports. `
    + 'Fill both or leave both empty — half an entry is not recorded.';
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

/** What the server did with a decision (routes/pipelines.ts, POST /:id/decision). */
type DecisionEffect =
  | { kind: 'advance'; from: string; to: string; final: boolean }
  | { kind: 'close'; outcome: Decision; atStageKey: string };

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

/**
 * Who conducted a human round. The named colleagues come first, because they
 * are the people the record can be attributed to; typed names follow, and are
 * all there is for an external panellist with no Questor account.
 */
export function ledBy(round: Round): string {
  const named = (round.panel ?? []).map((seat) => seat.name);
  const typed = round.interviewers.filter((name) => !named.includes(name));
  return [...named, ...typed].join(', ') || 'Human interviewer';
}

/**
 * What a round left behind. Three things a reader has to be able to tell apart,
 * and which a bare empty cell would run together: a round nobody has written
 * up, a round whose record is deliberately held back from THIS reader, and a
 * round that was written up and can be read.
 */
export function RoundRecord({ round }: { round: Round }) {
  if (round.conductedBy !== 'HUMAN') return <span className="muted small">—</span>;
  // Before the withheld case and before the empty one, because it is a
  // different fact about the round and the most actionable of the three: this
  // round is not going to happen, and somebody has to decide what does. The
  // same discipline as `notesWithheld` — a round that cannot run must never
  // read like a round nobody has written up yet.
  if (round.observerBlocked && round.status === 'SCHEDULED') {
    return (
      <div data-testid="round-observer-blocked">
        <span className="small">{round.observerBlocked.reason}</span>
        <ul className="muted small" style={{ margin: '4px 0 0 16px' }}>
          {round.observerBlocked.nextSteps.map((step) => <li key={step}>{step}</li>)}
        </ul>
      </div>
    );
  }
  if (round.notesWithheld) {
    return <span className="muted small" data-testid="round-notes-withheld">{round.notesWithheld}</span>;
  }
  const notes = round.notes ?? '';
  // Said above whatever the round holds, because it changes how to read it: a
  // record labelled with the interviewer's own account is a different thing
  // when the reason it is not a transcript is that the recording heard one
  // person.
  const capture = round.captureReport?.sentence
    ? <p className="small" data-testid="round-capture-report">{round.captureReport.sentence}</p>
    : null;
  if (!notes.trim()) {
    return (
      <div>
        {capture}
        <span className="muted small">{round.evidence?.label ?? 'Nothing recorded yet'}</span>
      </div>
    );
  }
  return (
    <details data-testid="round-record">
      {capture}
      <summary>{round.evidence?.label ?? 'Interviewer’s written record'}</summary>
      {round.recordedBy?.name && <p className="muted small">Recorded by {round.recordedBy.name}.</p>}
      {(round.evidenceEntries ?? []).map((entry) => (
        <div key={entry.competencyId} className="round-evidence-entry">
          <b>{entry.competencyName}</b>
          <p style={{ whiteSpace: 'pre-wrap' }}>{entry.claim}</p>
          {/* The quote is set apart from the claim on purpose: the two are
              different kinds of statement, and running them together is how a
              conclusion comes to look like the thing that supports it. */}
          <blockquote>{entry.quote}</blockquote>
        </div>
      ))}
      <p style={{ whiteSpace: 'pre-wrap' }}>{notes}</p>
      {round.evidence?.detail && <p className="muted small">{round.evidence.detail}</p>}
    </details>
  );
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
 *
 * `refreshKey` works the other way: the server moves candidates on its own
 * (an analysed resume, a scheduled interview), so when the page re-reads for
 * any reason the panel re-reads too and never shows a stage already left.
 */
export function PipelinePanel(
  { candidateId, candidateName, interviews, onChanged, refreshKey = 0 }:
  { candidateId: string; candidateName: string; interviews: InterviewOption[]; onChanged?: () => void; refreshKey?: number },
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

  const [roundDraft, setRoundDraft] = useState<ScheduleDraft>(EMPTY_SCHEDULE);
  const { timeZone: orgZone, failed: orgZoneFailed } = useOrgTimeZoneStatus();
  // What a round for this person should default to. Undefined until it is
  // read, so the picker does not pre-fill on the organisation's clock and then
  // change under the recruiter.
  const candidateTimeZone = useCandidateTimeZone(candidateId);
  const [interviewers, setInterviewers] = useState('');
  // Who will conduct the round. Only asked at the AI's own stage, which is the
  // only stage where there is a choice to make.
  const [conductedBy, setConductedBy] = useState<'AI' | 'HUMAN'>('AI');
  const [panelIds, setPanelIds] = useState<string[]>([]);
  const [team, setTeam] = useState<TeamInterviewer[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [decision, setDecision] = useState<Decision>('APPROVED');
  const [reason, setReason] = useState('');
  const [roundToComplete, setRoundToComplete] = useState('');
  const [roundNotes, setRoundNotes] = useState('');
  const [competencies, setCompetencies] = useState<Competency[]>([]);
  const [evidenceDraft, setEvidenceDraft] = useState<EvidenceDraft[]>([]);
  const [schedulingNotice, setSchedulingNotice] = useState<SchedulingNotice | null>(null);
  const [meetingLink, setMeetingLink] = useState('');
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [meetingNotice, setMeetingNotice] = useState<MeetingOutcome | null>(null);
  const [candidateNotice, setCandidateNotice] = useState<CandidateNotice | null>(null);
  const toast = useToast();
  const [meetingProvider, setMeetingProvider] = useState<MeetingProviderInfo | null>(null);
  // Set while a candidacy-ending outcome waits to be confirmed.
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);
  // The stage a move is waiting to be confirmed for.
  const [pendingAdvance, setPendingAdvance] = useState<string | null>(null);
  // Set while finalising the candidate waits to be confirmed.
  const [pendingFinalize, setPendingFinalize] = useState(false);
  // What the last decision did: an approval moves the candidate on, and the
  // person who recorded it should be told so rather than left to spot the
  // stage track changing.
  // Each action needs the capability its route checks; without it the panel
  // says who can, rather than offering a form that ends in "permission denied".
  const { user } = useAuth();
  const mayMove = can(user, 'interview:create');
  const maySchedule = can(user, 'interview:schedule');
  const mayDecide = can(user, 'assessment:review');

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
  }, [load, reloadKey, refreshKey]);

  // Which provider will create links for human rounds. Only read by people who
  // can schedule; without it the form simply asks for a link.
  useEffect(() => {
    if (!maySchedule) return undefined;
    let cancelled = false;
    api.get<{ meetingProvider: MeetingProviderInfo }>('/pipelines/meeting-provider')
      .then((resp) => { if (!cancelled) setMeetingProvider(resp.meetingProvider); })
      .catch(() => { if (!cancelled) setMeetingProvider(null); });
    return () => { cancelled = true; };
  }, [maySchedule]);

  // The colleagues who can be named to conduct a round. Read once per panel and
  // only by someone who can schedule; a failure leaves the picker out rather
  // than blocking the booking, which still works with typed names.
  useEffect(() => {
    if (!maySchedule) return undefined;
    let cancelled = false;
    api.get<{ interviewers: TeamInterviewer[] }>('/pipelines/interviewers')
      .then((resp) => { if (!cancelled) setTeam(resp.interviewers); })
      .catch(() => { if (!cancelled) setTeam([]); });
    return () => { cancelled = true; };
  }, [maySchedule]);

  // The competencies a round's record is filed under. Read from the pipeline
  // rather than the role, which is how an interviewer with no access to the
  // role still reaches the scorecard for the candidate they are interviewing.
  useEffect(() => {
    const id = pipeline?.id;
    if (!id) return undefined;
    let cancelled = false;
    api.get<{ competencies: Competency[] }>(`/pipelines/${id}/competencies`)
      .then((resp) => { if (!cancelled) setCompetencies(resp.competencies); })
      .catch(() => { if (!cancelled) setCompetencies([]); });
    return () => { cancelled = true; };
  }, [pipeline?.id]);

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
      <section className="card pipeline" data-tour="candidate-pipeline">
        <h2 className="card-title"><Icon name="flag" />Hiring pipeline</h2>
        <Skeleton lines={3} label="Loading pipeline…" />
      </section>
    );
  }

  if (loadError && (!pipeline || pipeline.candidateId !== candidateId)) {
    return (
      <section className="card pipeline" data-tour="candidate-pipeline">
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
      <section className="card pipeline" data-tour="candidate-pipeline">
        <h2 className="card-title"><Icon name="flag" />Hiring pipeline</h2>
        {error && <Banner kind="error">{error}</Banner>}
        <EmptyState
          compact
          icon="flag"
          title="No pipeline yet"
          message="Track this candidate from onboarding through the Bronze profile review, the Silver AI interview and any human rounds, with a decision recorded by a person."
          action={mayMove ? (
            <button className="btn" disabled={busy} onClick={() => run(() => api.post('/pipelines', { candidateId }))}>
              <Icon name={busy ? 'hourglass' : 'play'} size={16} />
              {busy ? 'Starting…' : 'Start pipeline'}
            </button>
          ) : <span className="muted small">{onlyWhoCan('interview:create', 'start a pipeline')}</span>}
        />
      </section>
    );
  }

  const states = stageStates(pipeline.stages, pipeline.currentStageKey, pipeline.status);
  const current = pipeline.stages.find((s) => s.key === pipeline.currentStageKey);
  const next = nextStage(pipeline.stages, pipeline.currentStageKey);
  const final = finalStage(pipeline.stages, pipeline.currentStageKey);
  const labelFor = (key: string | null) => pipeline.stages.find((s) => s.key === key)?.label ?? key ?? '';
  const isInterviewStage = current?.kind === 'ai_interview' || current?.kind === 'human_interview';
  const openHumanRounds = pipeline.rounds.filter((r) => r.conductedBy === 'HUMAN' && r.status === 'SCHEDULED');
  // Which set of fields the booking form asks for. A human round at the AI's
  // stage needs the human round's fields, not the AI's.
  const humanRoundForm = current?.kind === 'human_interview' || (current?.kind === 'ai_interview' && conductedBy === 'HUMAN');

  const scheduleRound = (e: React.FormEvent) => {
    e.preventDefault();
    if (!current) return;
    // A round in the past is almost always a mistyped date, and it reaches the
    // candidate as an invitation to a time that has already gone. A skipped
    // (spring-forward) time or an unknown zone is refused here too.
    const preview = schedulePreview(roundDraft, new Date(), browserTimeZone());
    if (preview.kind !== 'ok') {
      setError(preview.kind === 'problem' ? preview.text : 'Pick the time zone, then the date and time.');
      return;
    }
    const names = interviewers.split(',').map((n) => n.trim()).filter(Boolean);
    // Gold and Diamond are conducted by a person whatever is selected; Silver
    // offers the choice, because a team may want an SME in the room as well as
    // the AI interview.
    const human = current.kind === 'human_interview' || conductedBy === 'HUMAN';
    const link = meetingLink.trim();
    const linkProblem = human && link ? meetingLinkProblem(link) : null;
    if (linkProblem) {
      setError(linkProblem);
      return;
    }
    void run(() => api.post<{ notification?: SchedulingNotice; meeting?: MeetingOutcome | null; candidateNotice?: CandidateNotice }>(`/pipelines/${pipeline.id}/rounds`, {
      stageKey: current.key,
      ...scheduleRequest(roundDraft),
      ...(current.kind === 'ai_interview' ? { conductedBy: human ? 'HUMAN' : 'AI' } : {}),
      ...(!human && sessionId ? { sessionId } : {}),
      ...(human && names.length > 0 ? { interviewers: names } : {}),
      ...(human && panelIds.length > 0 ? { interviewerUserIds: panelIds } : {}),
      ...(human ? { durationMinutes } : {}),
      ...(human && link ? { meetingUrl: link } : {}),
    }).then((resp) => {
      noteScheduling(resp.notification ?? null);
      reportRound(resp.meeting ?? null, resp.candidateNotice ?? null);
      setRoundDraft((draft) => ({ ...EMPTY_SCHEDULE, timeZone: draft.timeZone }));
      setInterviewers('');
      setPanelIds([]);
      setSessionId('');
      setMeetingLink('');
    }));
  };

  // What went through is confirmed in a toast; only what still needs someone
  // (a meeting without a link, a candidate not told) stays on the page.
  const reportRound = (outcome: MeetingOutcome | null, candidate?: CandidateNotice | null) => {
    const meetingUrl = outcome?.ok ? safeMeetingUrl(outcome.url) : null;
    if (outcome?.ok) {
      toast.show(outcome.message, meetingUrl ? { action: <a href={meetingUrl} target="_blank" rel="noopener noreferrer">Join link</a> } : undefined);
    }
    setMeetingNotice(outcome && !outcome.ok ? outcome : null);
    if (candidate?.sent) toast.show(candidate.note, { testId: 'round-candidate-notice' });
    setCandidateNotice(candidate && !candidate.sent ? candidate : null);
  };

  const noteScheduling = (notice: SchedulingNotice | null) => {
    const link = notice?.delivered ? safeMeetingUrl(notice.link) : null;
    if (notice?.delivered) {
      toast.show(`Round scheduled. ${notice.deliveryNote}`, link ? { action: <a className="break-anywhere" href={link} target="_blank" rel="noopener noreferrer">{notice.link}</a> } : undefined);
    }
    setSchedulingNotice(notice && !notice.delivered ? notice : null);
  };

  const completeRound = (e: React.FormEvent) => {
    e.preventDefault();
    const roundId = roundToComplete || openHumanRounds[0]?.id;
    if (!roundId) return;
    // Stopped here rather than left to the server, because the round is about
    // to close for good and a competency dropped on the way through would be
    // dropped permanently. The banner alone was not enough: it is advisory, and
    // the button beside it still worked.
    const halfWritten = evidenceDraftWarning(evidenceDraft, competencies);
    if (halfWritten) {
      setError(halfWritten);
      return;
    }
    const entries = readyEntries(evidenceDraft);
    void run(() => api.post(`/pipelines/${pipeline.id}/rounds/${roundId}/complete`, {
      notes: roundNotes,
      ...(entries.length > 0 ? { evidence: entries } : {}),
    }).then(() => { setRoundNotes(''); setRoundToComplete(''); setEvidenceDraft([]); }));
  };

  const setEvidenceField = (competencyId: string, field: 'claim' | 'quote', value: string) => {
    setEvidenceDraft((draft) => {
      const existing = draft.find((entry) => entry.competencyId === competencyId);
      if (!existing) return [...draft, { competencyId, claim: '', quote: '', [field]: value }];
      return draft.map((entry) => (entry.competencyId === competencyId ? { ...entry, [field]: value } : entry));
    });
  };

  const evidenceValueOf = (competencyId: string, field: 'claim' | 'quote') =>
    evidenceDraft.find((entry) => entry.competencyId === competencyId)?.[field] ?? '';

  const submitDecision = () => {
    // Trimmed and checked here, not only by the browser: this reason is the
    // record of why someone's candidacy ended.
    if (reason.trim().length < MIN_DECISION_REASON) {
      setError(`Say why in at least ${MIN_DECISION_REASON} characters — this is the record of the decision.`);
      return;
    }
    // The stage travels with the decision: if the candidate moved on while the
    // form was open, the server refuses rather than deciding the wrong round.
    void run(() => api.post<{ effect: DecisionEffect }>(`/pipelines/${pipeline.id}/decision`, {
      decision, reason: reason.trim(), stageKey: pipeline.currentStageKey,
    }).then((resp) => {
      setReason('');
      setPendingDecision(null);
      const effect = resp.effect;
      // A final approval closes the pipeline, whose panel then says so itself.
      if (effect?.kind === 'advance' && !effect.final) {
        toast.show(`${candidateName} moves to ${labelFor(effect.to)}.`, { testId: 'decision-notice' });
      }
    }));
  };

  // Approving moves someone forward — to the next stage, or to a recorded
  // approval at the last one; the other two end their candidacy and close the
  // pipeline, and nothing in this panel undoes that. Those two get named
  // back — outcome and person — before they are recorded.
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

  // Finalising is the one move the process never makes by itself, and it
  // skips every stage in between — so it is confirmed before it is sent.
  const finalize = () => {
    if (!final) return;
    if (!pendingFinalize) { setPendingFinalize(true); return; }
    setPendingFinalize(false);
    void run(() => api.post(`/pipelines/${pipeline.id}/finalize`, {}));
  };

  return (
    <section className="card pipeline" data-tour="candidate-pipeline">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <h2 className="card-title" style={{ margin: 0 }}><Icon name="flag" />Hiring pipeline</h2>
        <StatusBadge kind="pipeline" value={pipeline.status} />
      </div>
      {error && <Banner kind="error">{error}</Banner>}

      {meetingNotice && (
        <Banner kind="error">
          {meetingNotice.message}{' '}
          {safeMeetingUrl(meetingNotice.url) && (
            <a href={safeMeetingUrl(meetingNotice.url) ?? undefined} target="_blank" rel="noopener noreferrer">Join link</a>
          )}
          {!meetingNotice.ok && meetingNotice.status === 'NEEDS_LINK' && ' Use "Try again" or "Add link manually" in the rounds table below.'}
        </Banner>
      )}

      {candidateNotice && (
        <Banner kind="info">
          <span data-testid="round-candidate-notice">{candidateNotice.note}</span>
        </Banner>
      )}

      {schedulingNotice && (
        <Banner kind="info">
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
        <>
          <p className="journey-outcome" data-testid="pipeline-outcome">
            <span className="journey-outcome-label">Outcome</span>
            {pipelineOutcome(pipeline.stages, pipeline).text}
          </p>
          <Banner kind="info">
            {/* Badge labels come from statusModel and match DECISION_TEXT. */}
            <StatusBadge kind="decision" value={pipeline.decision ?? 'APPROVED'} />{' '}
            at {labelFor(pipeline.decidedAtStageKey)}. {pipeline.decisionReason}
          </Banner>
        </>
      ) : (
        <div className="pipeline-actions grid cols-3">
          <div className="pipeline-action">
            <h3 className="card-title"><Icon name="arrow-right" size={16} />Next stage</h3>
            {!mayMove ? (
              <p className="muted small">{onlyWhoCan('interview:create', 'move a candidate on')}</p>
            ) : next ? (
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
            {final && mayDecide && (
              <div style={{ marginTop: 10 }}>
                <button type="button" className="btn secondary" disabled={busy} onClick={finalize} data-testid="pipeline-finalize">
                  <Icon name="check-circle" size={16} />
                  {pendingFinalize ? `Confirm finalise as ${final.label}` : `Finalise (${final.label})`}
                </button>
                {pendingFinalize && (
                  <p className="muted small" style={{ marginTop: 6 }}>
                    {candidateName} is finalised and moves straight to {final.label}. This is recorded against your name.{' '}
                    <button type="button" className="btn ghost sm" onClick={() => setPendingFinalize(false)}>Not yet</button>
                  </p>
                )}
              </div>
            )}
          </div>

          <form className="pipeline-action" onSubmit={scheduleRound}>
            <h3 className="card-title"><Icon name="schedule" size={16} />Schedule {current ? `${current.label} round` : 'round'}</h3>
            {!maySchedule ? (
              <p className="muted small">{onlyWhoCan('interview:schedule', 'schedule rounds')}</p>
            ) : isInterviewStage ? (
              <>
                {orgZoneFailed && <Banner kind="info"><span data-testid="org-zone-failed">{orgTimeZoneLoadNotice()}</span></Banner>}
                <TimeZoneDateTimePicker
                  idPrefix="round-when"
                  value={roundDraft}
                  onChange={setRoundDraft}
                  orgZone={orgZone}
                  candidate={candidateTimeZone}
                  disabled={busy}
                />
                {/* Only the AI's own stage has a choice to make: everything
                    later is conducted by a person whatever is selected. */}
                {current?.kind === 'ai_interview' && (
                  <>
                    <label htmlFor="round-conductor">Conducted by</label>
                    <select id="round-conductor" value={conductedBy} onChange={(e) => setConductedBy(e.target.value as 'AI' | 'HUMAN')}>
                      <option value="AI">The AI interviewer</option>
                      <option value="HUMAN">A person (SME or recruiter)</option>
                    </select>
                  </>
                )}
                {!humanRoundForm ? (
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
                    {team.length > 0 && (
                      <>
                        <label htmlFor="round-panel">Who is conducting it</label>
                        {/* Named colleagues rather than typed names: the record
                            of this round is attributed to them, and the first
                            one selected is the name a certificate prints. */}
                        <select
                          id="round-panel" multiple size={Math.min(team.length, 5)} value={panelIds}
                          onChange={(e) => setPanelIds(Array.from(e.target.selectedOptions, (o) => o.value))}
                        >
                          {team.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.role}</option>)}
                        </select>
                        <p className="muted small">
                          They are given this candidate so they can open the round. Another interviewer&rsquo;s
                          record of the same stage stays closed to them until you decide.
                        </p>
                      </>
                    )}
                    <label htmlFor="round-people">Anyone else in the room</label>
                    <input id="round-people" value={interviewers} onChange={(e) => setInterviewers(e.target.value)} placeholder="External panellist, client-side lead" />
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
            {!mayDecide ? (
              <p className="muted small" data-testid="decision-not-allowed">{onlyWhoCan('assessment:review', 'record a decision or finalise a candidate')}</p>
            ) : (<>
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
            </>)}
          </form>
        </div>
      )}

      {pipeline.rounds.length > 0 && (
        <>
          <h3 className="card-title"><Icon name="schedule" size={16} />Rounds</h3>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Interview rounds">
          <table>
            <thead>
              <tr><th>Stage</th><th>Led by</th><th>Observers</th><th>Scheduled</th><th>Status</th><th>Record</th><th>Meeting</th><th scope="col" aria-label="Manage round" /></tr>
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
                      : ledBy(round)}
                  </td>
                  <td className="muted small">{round.hrMayObserve ? 'HR may observe' : round.aiObserver ? 'AI observer' : '—'}</td>
                  <td>{formatScheduled(round.scheduledAt, round.scheduledTimeZone, orgZone)}</td>
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
                  <td><RoundRecord round={round} /></td>
                  <td>
                    <RoundMeeting
                      pipelineId={pipeline.id} round={round} busy={busy} run={run}
                      onOutcome={reportRound} onError={setError} readOnly={!maySchedule}
                      vendorReady={meetingProvider !== null && meetingProvider.provider !== 'manual' && meetingProvider.configured}
                    />
                  </td>
                  <td>
                    {maySchedule && (
                      <RoundActions
                        pipelineId={pipeline.id} round={round} busy={busy} run={run}
                        onOutcome={reportRound} onError={setError}
                        canReschedule={pipeline.status === 'ACTIVE'} orgZone={orgZone}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {openHumanRounds.length > 0 && maySchedule && (
        <form className="pipeline-action pipeline-complete" onSubmit={completeRound}>
          <h3 className="card-title"><Icon name="human-review" size={16} />Complete a human round</h3>
          <p className="muted small">What the interviewers recorded becomes the evidence for this stage.</p>
          {openHumanRounds.length > 1 && (
            <>
              <label htmlFor="complete-round">Round</label>
              <select id="complete-round" value={roundToComplete || openHumanRounds[0].id} onChange={(e) => setRoundToComplete(e.target.value)}>
                {openHumanRounds.map((round) => (
                  <option key={round.id} value={round.id}>{labelFor(round.stageKey)} · {formatScheduled(round.scheduledAt, round.scheduledTimeZone, orgZone)}</option>
                ))}
              </select>
            </>
          )}
          {competencies.length > 0 && (
            <div className="round-evidence">
              <h4 className="card-title">What they showed, by competency</h4>
              <p className="muted small">
                Filed the same way the AI files its evidence, so the two can be read side by side. Quote what
                they actually said, as closely as you can — a claim with nothing under it is not evidence.
                These are your words for what you heard, not a recording of it. Leave a competency blank if
                the round did not reach it.
              </p>
              {competencies.map((competency) => (
                <fieldset key={competency.id} className="round-evidence-row">
                  <legend>{competency.name}</legend>
                  <label htmlFor={`claim-${competency.id}`}>What it showed</label>
                  <textarea
                    id={`claim-${competency.id}`} rows={2}
                    value={evidenceValueOf(competency.id, 'claim')}
                    onChange={(e) => setEvidenceField(competency.id, 'claim', e.target.value)}
                    placeholder="What you concluded about this competency."
                  />
                  <label htmlFor={`quote-${competency.id}`}>What they said</label>
                  <textarea
                    id={`quote-${competency.id}`} rows={2}
                    value={evidenceValueOf(competency.id, 'quote')}
                    onChange={(e) => setEvidenceField(competency.id, 'quote', e.target.value)}
                    placeholder="Their own words, as close as you can get them."
                  />
                </fieldset>
              ))}
              {evidenceDraftWarning(evidenceDraft, competencies) && (
                <Banner kind="info"><span data-testid="evidence-draft-warning">{evidenceDraftWarning(evidenceDraft, competencies)}</span></Banner>
              )}
            </div>
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
