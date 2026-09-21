/**
 * The candidate journey: what the server holds about one candidate, arranged as
 * the four steps a recruiter actually walks through.
 *
 *   1. Onboard            who they are, the job, their resume, the job fit
 *   2. AI interview       the one round an AI interviewer conducts, and its state
 *   3. Schedule           the human rounds — run by people, recorded here
 *   4. Decision & evidence what the evidence says, and the outcome a person records
 *
 * Kept free of React so it can be unit tested in the node environment (see
 * web/tests/candidateJourney.test.ts), and so the wording below — which is the
 * part that can quietly become untrue — is checked rather than reviewed.
 *
 * Two rules govern every string in this file:
 *   - Questor does not host human rounds. It records when they happen, who is
 *     in them, and what a person wrote afterwards.
 *   - There is no audio. Evidence is a quote from the written transcript with
 *     the time it was said, and live observation is that transcript as it is
 *     written — never a feed.
 */

import type { IconName } from './Icon';
import { pipelineOutcome, stageStates, type PipelineStageView, type StageKind, type StageState } from './pipelineView';
import { roundScore } from './scoreFormat';
import { buildFeedbackView } from './journeyFeedbackView';

// ---------------------------------------------------------------------------
// What the server gives us (narrowed to the fields the journey reads)
// ---------------------------------------------------------------------------

export interface JourneyCandidate {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly roleId: string | null;
}

/** The role, plus its latest scorecard — which is the job description, parsed. */
export interface JourneyRole {
  readonly title: string;
  readonly level?: string | null;
  readonly context?: string;
  readonly outcomes?: readonly string[];
  readonly responsibilities?: readonly string[];
  readonly scorecardVersion?: number | null;
  readonly scorecardStatus?: string | null;
}

export interface JourneyProfileData {
  readonly skills?: readonly string[];
  readonly totalYears?: number | null;
}

export interface JourneyFitData {
  readonly overall: number;
  readonly confidence: number;
  readonly missing?: readonly string[];
  readonly probes?: readonly string[];
}

export interface JourneySession {
  readonly id: string;
  readonly state: string;
  readonly scheduledAt: string | null;
  readonly createdAt: string;
}

/** The per-session extras that only GET /interviews carries. */
export interface JourneySessionMeta {
  readonly recommendation: string | null;
  readonly assessmentId: string | null;
  readonly invited: boolean;
  /** The AI interviewer's name for this session; absent on an older server. */
  readonly personaName?: string | null;
}

/** What to call the AI interviewer when the session does not say. */
export const DEFAULT_INTERVIEWER = 'the interviewer';

/**
 * The interviewer's name for a session.
 *
 * WHY this is not a constant: each interview has its own AI interviewer, so a
 * hardcoded name describes someone the candidate may never have spoken to.
 */
export function interviewerName(name: string | null | undefined): string {
  return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_INTERVIEWER;
}

export interface JourneyRound {
  readonly id: string;
  readonly stageKey: string;
  readonly conductedBy: 'AI' | 'HUMAN';
  readonly sessionId: string | null;
  readonly interviewers: readonly string[];
  readonly scheduledAt: string;
  readonly status: string;
  readonly notes?: string;
  readonly completedAt?: string | null;
}

export interface JourneyPipeline {
  readonly id: string;
  readonly stages: readonly PipelineStageView[];
  readonly currentStageKey: string;
  readonly status: string;
  readonly decision: string | null;
  readonly decisionReason: string | null;
  readonly decidedAtStageKey: string | null;
  readonly decidedAt?: string | null;
  readonly rounds: readonly JourneyRound[];
}

export interface JourneyEvidence {
  readonly quote: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface JourneyCompetency {
  readonly name: string;
  readonly level: number | null;
  readonly requiredLevel: number;
  readonly notEnoughEvidence: boolean;
  readonly evidence?: readonly JourneyEvidence[];
}

export interface JourneyAssessment {
  readonly id: string;
  readonly recommendation: string | null;
  readonly summary?: string;
  readonly competencies?: readonly JourneyCompetency[];
}

export interface JourneyInput {
  readonly candidate: JourneyCandidate;
  readonly role: JourneyRole | null;
  readonly profile: JourneyProfileData | null;
  readonly fit: JourneyFitData | null;
  readonly resumeText: string;
  readonly sessions: readonly JourneySession[];
  readonly sessionMeta: Readonly<Record<string, JourneySessionMeta>>;
  readonly pipeline: JourneyPipeline | null;
  readonly assessment: JourneyAssessment | null;
  /**
   * Set when the assessment exists but was refused: blind review comes first.
   * Carried as the server's own sentence so this page cannot soften it.
   */
  readonly assessmentBlockedReason: string | null;
  /** Stage labels the pipeline summary reports no evidence for. */
  readonly missingEvidence: readonly string[];
  /**
   * What the candidate themselves asked for at the end of their interview, from
   * GET /candidates/:id. Null when the server did not report it.
   *
   * Required rather than optional on purpose: "we have no idea" and "they said
   * no" are different facts with different consequences, and a field that can be
   * quietly omitted is how the second gets rendered as the first.
   */
  readonly candidateFeedback: JourneyCandidateFeedback | null;
}

/** As the server reports it — see services/candidateFeedback.ts. */
export interface JourneyCandidateFeedback {
  readonly optIn: { readonly choice: string; readonly decidedAt: string | null } | null;
  readonly draft: {
    readonly status: string | null;
    readonly candidateRequested: boolean;
    readonly assessmentId: string | null;
  } | null;
  readonly humanRequest: { readonly requested: boolean; readonly requestedAt: string | null } | null;
}

// ---------------------------------------------------------------------------
// What the board renders
// ---------------------------------------------------------------------------

export type ColumnKey = 'onboard' | 'ai-interview' | 'schedule' | 'decision';
export type ColumnState = 'done' | 'current' | 'upcoming';

interface ColumnBase {
  readonly step: number;
  readonly title: string;
  readonly icon: IconName;
  readonly state: ColumnState;
}

export interface JourneyProfileCard {
  readonly initials: string;
  readonly fullName: string;
  readonly email: string;
  readonly roleTitle: string | null;
}

export interface JourneyJobDescription {
  readonly available: boolean;
  readonly source: string;
  readonly context: string;
  readonly outcomes: readonly string[];
  readonly responsibilities: readonly string[];
  readonly note: string;
}

export interface JourneyResume {
  readonly parsed: boolean;
  readonly totalYears: number | null;
  readonly skills: readonly string[];
  readonly excerpt: string;
  readonly note: string;
}

export interface JourneyFit {
  readonly scored: boolean;
  readonly overall: number | null;
  readonly confidence: number | null;
  readonly missing: readonly string[];
  readonly probes: readonly string[];
  readonly note: string;
}

export interface OnboardColumn extends ColumnBase {
  readonly key: 'onboard';
  readonly profile: JourneyProfileCard;
  readonly job: JourneyJobDescription;
  readonly resume: JourneyResume;
  readonly fit: JourneyFit;
}

export type AiInterviewPhase =
  | 'none' | 'not-invited' | 'invited' | 'in-progress'
  | 'processing' | 'awaiting-review' | 'reviewed' | 'ended';

export interface AiInterviewColumn extends ColumnBase {
  readonly key: 'ai-interview';
  readonly stageLabel: string | null;
  readonly session: JourneySession | null;
  readonly phase: AiInterviewPhase;
  /** Who conducts it, already resolved to a name the page can print. */
  readonly personaName: string;
  readonly statusNote: string;
  readonly scheduledAt: string | null;
  readonly completedAt: string | null;
  readonly awaitingHumanReview: boolean;
  readonly observeHref: string | null;
  readonly observeNote: string;
  readonly transcriptHref: string | null;
  readonly assessmentHref: string | null;
  readonly interviewHref: string | null;
  readonly conductedByNote: string;
}

export interface JourneyRoundCard {
  readonly id: string;
  readonly stageLabel: string;
  readonly interviewers: readonly string[];
  readonly interviewerNote: string;
  readonly scheduledAt: string;
  readonly completedAt: string | null;
  readonly status: string;
}

export interface JourneyHumanStage {
  readonly key: string;
  readonly label: string;
  readonly state: StageState;
  readonly rounds: readonly JourneyRoundCard[];
  readonly note: string;
}

export interface ScheduleColumn extends ColumnBase {
  readonly key: 'schedule';
  readonly stages: readonly JourneyHumanStage[];
  /** Rounds recorded against a stage the role plan no longer contains. */
  readonly orphanRounds: readonly JourneyRoundCard[];
  readonly openRounds: readonly JourneyRoundCard[];
  readonly note: string;
}

export interface JourneyQuote {
  readonly competency: string;
  readonly quote: string;
  readonly timing: string;
}

export interface JourneyAssessmentView {
  readonly available: boolean;
  readonly blocked: boolean;
  readonly summary: string;
  readonly quotes: readonly JourneyQuote[];
  readonly notEnoughEvidence: readonly string[];
  readonly href: string | null;
  readonly note: string;
  readonly evidenceNote: string;
}

export interface JourneyHumanNote {
  readonly roundId: string;
  readonly stageLabel: string;
  readonly interviewers: readonly string[];
  readonly completedAt: string | null;
  readonly notes: string;
  /** False once retention has cleared what was written (services/dataRights.ts). */
  readonly retained: boolean;
}

export interface JourneyDecisionRecord {
  readonly recorded: boolean;
  readonly value: string | null;
  readonly reason: string;
  readonly stageLabel: string | null;
  readonly decidedAt: string | null;
  /**
   * Where the journey stands, in one line (pipelineView.pipelineOutcome): the
   * final word once a decision has ended it, progress until then. Null with
   * no pipeline — there is no journey to report on yet.
   */
  readonly outcome: string | null;
}

/**
 * What the candidate asked for, as the hiring team needs to read it.
 *
 * Three separate facts, deliberately not collapsed into one status: whether they
 * wanted feedback, whether a draft is waiting for someone, and whether they have
 * asked to speak to a person. The third can be true whatever the other two say.
 */
export interface JourneyFeedbackView {
  /** False when no answer was ever recorded — which is NOT a refusal. */
  readonly answered: boolean;
  readonly wantsFeedback: boolean;
  readonly answerLabel: string;
  readonly decidedAt: string | null;
  readonly draftWaiting: boolean;
  readonly draftLabel: string;
  readonly draftHref: string | null;
  readonly humanRequested: boolean;
  readonly humanRequestedAt: string | null;
  readonly humanRequestLabel: string;
}

export interface DecisionColumn extends ColumnBase {
  readonly key: 'decision';
  readonly assessment: JourneyAssessmentView;
  readonly recommendation: string | null;
  readonly humanNotes: readonly JourneyHumanNote[];
  readonly humanNotesNote: string;
  readonly decision: JourneyDecisionRecord;
  readonly evidenceGaps: readonly string[];
  readonly candidateFeedback: JourneyFeedbackView;
}

export type JourneyColumn = OnboardColumn | AiInterviewColumn | ScheduleColumn | DecisionColumn;

export interface CandidateJourney {
  readonly title: string;
  readonly columns: readonly [OnboardColumn, AiInterviewColumn, ScheduleColumn, DecisionColumn];
  readonly onboard: OnboardColumn;
  readonly aiInterview: AiInterviewColumn;
  readonly schedule: ScheduleColumn;
  readonly decision: DecisionColumn;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/** Initials for the avatar. Questor shows initials, never a photograph. */
export function initialsOf(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] ?? '' : '';
  return `${first}${last}`.toUpperCase() || '?';
}

export function journeyTitle(roleTitle: string | null): string {
  return roleTitle ? `Candidate journey: ${roleTitle}` : 'Candidate journey';
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Where in the interview a quote was said. Minutes and seconds into the
 * transcript — the only timing Questor has, because it keeps no audio.
 */
export function quoteTiming(startMs: number, endMs: number): string {
  const start = clock(startMs);
  const end = clock(endMs);
  return start === end ? start : `${start}–${end}`;
}

// ---------------------------------------------------------------------------
// Column placement
// ---------------------------------------------------------------------------

/** Which of the four columns owns a stage of this kind. */
const COLUMN_OF_KIND: Readonly<Record<StageKind, number>> = {
  intake: 0,
  profile_review: 0,
  ai_interview: 1,
  human_interview: 2,
};

function columnStates(pipeline: JourneyPipeline | null): [ColumnState, ColumnState, ColumnState, ColumnState] {
  // No pipeline: onboarding is genuinely all that has happened to this person.
  if (!pipeline) return ['current', 'upcoming', 'upcoming', 'upcoming'];

  // A step the role's plan does not contain cannot be "done" — nothing ever
  // happened there. The stage schema allows a plan with no AI interview at all,
  // and reading position by ordinal alone marked that step complete for a
  // candidate who had never spoken to an AI interviewer.
  const planned = [0, 1, 2].map((column) => pipeline.stages.some((s) => COLUMN_OF_KIND[s.kind] === column));
  const settled = (column: number): ColumnState => (planned[column] ? 'done' : 'upcoming');

  if (pipeline.status === 'DECIDED') return [settled(0), settled(1), settled(2), 'current'];

  const stage = pipeline.stages.find((s) => s.key === pipeline.currentStageKey);
  const active = stage ? COLUMN_OF_KIND[stage.kind] : 0;
  const state = (index: number): ColumnState => {
    if (index === active) return 'current';
    if (index < active) return settled(index);
    return 'upcoming';
  };
  return [state(0), state(1), state(2), state(3)];
}

function labelOf(pipeline: JourneyPipeline | null, stageKey: string | null): string {
  if (!stageKey) return '';
  // A round can outlive the stage it was scheduled for: the role's plan may have
  // been rewritten since. Showing the raw key is worse than a label but far
  // better than dropping the round.
  return pipeline?.stages.find((s) => s.key === stageKey)?.label ?? stageKey;
}

// ---------------------------------------------------------------------------
// 1. Onboard
// ---------------------------------------------------------------------------

const RESUME_EXCERPT_CHARS = 420;

function buildOnboard(input: JourneyInput, state: ColumnState): OnboardColumn {
  const { role, profile, fit } = input;
  const jobLines = [...(role?.outcomes ?? []), ...(role?.responsibilities ?? [])];
  const jobAvailable = !!role && (jobLines.length > 0 || (role.context ?? '').trim().length > 0);
  const resumeText = input.resumeText ?? '';
  const parsed = resumeText.trim().length > 0 || profile !== null;

  return {
    key: 'onboard',
    step: 1,
    title: 'Onboard',
    icon: 'onboard',
    state,
    profile: {
      initials: initialsOf(input.candidate.fullName),
      fullName: input.candidate.fullName,
      email: input.candidate.email,
      roleTitle: role?.title ?? null,
    },
    job: {
      available: jobAvailable,
      source: role?.scorecardVersion != null
        ? `Scorecard v${role.scorecardVersion}${role.scorecardStatus ? ` · ${role.scorecardStatus}` : ''}`
        : '',
      context: role?.context ?? '',
      outcomes: role?.outcomes ?? [],
      responsibilities: role?.responsibilities ?? [],
      note: jobAvailable ? '' : 'No scorecard has been drafted from this role’s job description yet.',
    },
    resume: {
      parsed,
      totalYears: profile?.totalYears ?? null,
      skills: profile?.skills ?? [],
      excerpt: resumeText.slice(0, RESUME_EXCERPT_CHARS),
      note: parsed ? '' : 'No resume has been parsed for this candidate yet.',
    },
    fit: {
      scored: fit !== null,
      // Null, not NaN: a fit result stored before `overall` existed still has
      // scored = true, and the board must not print a rounded undefined.
      overall: roundScore(fit?.overall),
      confidence: fit ? fit.confidence : null,
      missing: fit?.missing ?? [],
      probes: fit?.probes ?? [],
      note: fit
        ? 'Scored from the resume against the role scorecard, before anyone spoke to the candidate.'
        : 'No job-fit result yet. Upload a resume to score one.',
    },
  };
}

// ---------------------------------------------------------------------------
// 2. AI interview
// ---------------------------------------------------------------------------

/** States in which the candidate may be on the call right now (server: interviews.ts). */
const LIVE_STATES = new Set([
  'READY_CHECK', 'WAITING', 'CONNECTING', 'DISCLOSURE', 'CONSENTED', 'WARMUP',
  'ASSESSING', 'CANDIDATE_QUESTIONS', 'CLOSING',
]);
const NOT_STARTED_STATES = new Set(['PROVISIONED', 'INVITED']);
const REVIEWED_STATES = new Set(['HUMAN_REVIEWED', 'CLOSED']);
const ENDED_WITHOUT_STATES = new Set([
  'NO_SHOW', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE', 'POLICY_STOP',
  'CANCELLED', 'INCOMPLETE', 'MANUAL_HANDOFF', 'RESCHEDULE_REQUIRED',
]);

const PHASE_NOTE: Readonly<Record<AiInterviewPhase, string>> = {
  none: 'No AI interview has been created for this candidate yet.',
  'not-invited': 'Created, but the invitation has not been sent yet.',
  invited: 'Invited. The candidate has not started yet.',
  // Rewritten with the session's own interviewer name; see buildAiInterview.
  'in-progress': 'Underway now.',
  processing: 'Finished. The assessment is being written.',
  'awaiting-review': 'Awaiting human review — the assessment is ready and no person has signed it off yet.',
  reviewed: 'Reviewed by a person.',
  ended: 'Ended without a completed interview.',
};

function phaseOf(session: JourneySession | null, meta: JourneySessionMeta | undefined): AiInterviewPhase {
  if (!session) return 'none';
  const state = session.state;
  if (state === 'PROVISIONED' && meta && !meta.invited) return 'not-invited';
  if (NOT_STARTED_STATES.has(state)) return 'invited';
  if (LIVE_STATES.has(state)) return 'in-progress';
  if (state === 'PROCESSING') return 'processing';
  if (state === 'REVIEW_READY') return 'awaiting-review';
  if (REVIEWED_STATES.has(state)) return 'reviewed';
  if (ENDED_WITHOUT_STATES.has(state)) return 'ended';
  // An unrecognised state is treated as still running, the same deny-list
  // reading the candidate list uses: a new intermediate state must not read as
  // finished and quietly drop off someone's follow-up list.
  return 'in-progress';
}

interface SelectedInterview {
  readonly session: JourneySession | null;
  readonly meta: JourneySessionMeta | undefined;
  readonly stage: PipelineStageView | null;
  readonly round: JourneyRound | null;
}

/**
 * The one interview this board is about.
 *
 * Chosen once and shared by the AI column and the decision column, so the
 * recommendation beside the evidence always belongs to the same session as the
 * transcript above it. A candidate can have several sessions — a retake, a
 * rescheduled no-show — and picking one per column let a retake's verdict sit
 * beside a different interview's state.
 */
function selectAiInterview(input: JourneyInput): SelectedInterview {
  const { pipeline } = input;
  const stage = pipeline?.stages.find((s) => s.kind === 'ai_interview') ?? null;
  const round = stage
    ? pipeline?.rounds.find((r) => r.conductedBy === 'AI' && r.stageKey === stage.key) ?? null
    : null;
  const linked = round?.sessionId ? input.sessions.find((s) => s.id === round.sessionId) : undefined;
  // Sessions arrive newest first, so the newest is the one a recruiter means by
  // "the interview" when no round has been linked to one yet.
  const session = linked ?? input.sessions[0] ?? null;
  return { session, meta: session ? input.sessionMeta[session.id] : undefined, stage, round };
}

function buildAiInterview(input: JourneyInput, state: ColumnState, selected: SelectedInterview): AiInterviewColumn {
  const { session, meta, stage: aiStage, round: aiRound } = selected;
  const phase = phaseOf(session, meta);
  const interviewer = interviewerName(meta?.personaName);

  const live = phase === 'in-progress';
  const ended = phase === 'processing' || phase === 'awaiting-review' || phase === 'reviewed' || phase === 'ended';

  return {
    key: 'ai-interview',
    step: 2,
    title: 'AI interview',
    icon: 'interviews',
    state,
    stageLabel: aiStage?.label ?? null,
    session,
    phase,
    personaName: interviewer,
    statusNote: phase === 'in-progress' ? `Underway with ${interviewer} now.` : PHASE_NOTE[phase],
    scheduledAt: aiRound?.scheduledAt ?? session?.scheduledAt ?? null,
    completedAt: aiRound?.completedAt ?? null,
    awaitingHumanReview: phase === 'awaiting-review',
    observeHref: live && session ? `/interviews/${session.id}/observe` : null,
    observeNote: live
      ? 'Read-only: the transcript as it is written, with no way to reach the candidate. It opens only if the candidate was told, before consenting, that the hiring team may observe.'
      : ended
        ? 'The interview has ended — read the transcript instead.'
        : 'Live observation opens once the candidate has joined and answered.',
    transcriptHref: ended && session ? `/interviews/${session.id}` : null,
    assessmentHref: meta?.assessmentId ? `/assessments/${meta.assessmentId}` : null,
    interviewHref: session ? `/interviews/${session.id}` : null,
    conductedByNote: `Conducted by ${interviewer}. A written transcript is kept; no audio is recorded.`,
  };
}

// ---------------------------------------------------------------------------
// 3. Schedule (the human rounds)
// ---------------------------------------------------------------------------

const NO_INTERVIEWERS = 'Interviewers not named yet.';

function toRoundCard(round: JourneyRound, pipeline: JourneyPipeline | null): JourneyRoundCard {
  return {
    id: round.id,
    stageLabel: labelOf(pipeline, round.stageKey),
    interviewers: round.interviewers,
    interviewerNote: round.interviewers.length > 0 ? '' : NO_INTERVIEWERS,
    scheduledAt: round.scheduledAt,
    completedAt: round.completedAt ?? null,
    status: round.status,
  };
}

function buildSchedule(input: JourneyInput, state: ColumnState): ScheduleColumn {
  const { pipeline } = input;
  const note = 'These rounds are run by people. Questor records when they happen, who is in them and what was '
    + 'written down afterwards — it does not host them.';

  if (!pipeline) {
    return {
      key: 'schedule',
      step: 3,
      title: 'Schedule',
      icon: 'schedule',
      state,
      stages: [],
      orphanRounds: [],
      openRounds: [],
      note: `Start the pipeline to schedule human rounds. ${note}`,
    };
  }

  const states = stageStates(pipeline.stages, pipeline.currentStageKey, pipeline.status);
  const humanRounds = pipeline.rounds.filter((r) => r.conductedBy === 'HUMAN');
  const planKeys = new Set(pipeline.stages.map((s) => s.key));

  const stages: JourneyHumanStage[] = pipeline.stages
    .map((stage, index) => ({ stage, stageState: states[index] }))
    .filter(({ stage }) => stage.kind === 'human_interview')
    .map(({ stage, stageState }) => {
      const rounds = humanRounds.filter((r) => r.stageKey === stage.key).map((r) => toRoundCard(r, pipeline));
      return {
        key: stage.key,
        label: stage.label,
        state: stageState,
        rounds,
        note: rounds.length > 0 ? '' : 'No round scheduled for this stage yet.',
      };
    });

  return {
    key: 'schedule',
    step: 3,
    title: 'Schedule',
    icon: 'schedule',
    state,
    stages,
    orphanRounds: humanRounds.filter((r) => !planKeys.has(r.stageKey)).map((r) => toRoundCard(r, pipeline)),
    openRounds: humanRounds.filter((r) => r.status === 'SCHEDULED').map((r) => toRoundCard(r, pipeline)),
    note,
  };
}

// ---------------------------------------------------------------------------
// 4. Decision & evidence
// ---------------------------------------------------------------------------

const EVIDENCE_NOTE = 'Every quote is taken from the written transcript, with the time it was said. '
  + 'Questor stores no audio, so there is nothing to play back.';

const PURGED_NOTES = 'These notes have passed their retention window and were cleared.';

/**
 * `assessmentId` is passed in rather than read off `input.assessment`, because
 * the case that most needs a link is the one where there IS no assessment
 * object: blind review refused it. Deriving the link from the object left the
 * "record your verdict" route unreachable exactly when it was the only way
 * forward.
 */
function buildAssessmentView(input: JourneyInput, assessmentId: string | null): JourneyAssessmentView {
  const href = assessmentId ? `/assessments/${assessmentId}` : null;

  if (input.assessmentBlockedReason) {
    return {
      available: false,
      blocked: true,
      summary: '',
      quotes: [],
      notEnoughEvidence: [],
      href,
      // The server's own sentence, verbatim: this page must not be able to
      // describe the blind-review gate more softly than the gate itself does.
      note: input.assessmentBlockedReason,
      evidenceNote: EVIDENCE_NOTE,
    };
  }

  if (!input.assessment) {
    return {
      available: false,
      blocked: false,
      summary: '',
      quotes: [],
      notEnoughEvidence: [],
      href,
      note: 'No assessment yet. One is written after the AI interview finishes.',
      evidenceNote: EVIDENCE_NOTE,
    };
  }

  const competencies = input.assessment.competencies ?? [];
  const quotes: JourneyQuote[] = competencies.flatMap((competency) =>
    (competency.evidence ?? []).map((evidence) => ({
      competency: competency.name,
      quote: evidence.quote,
      timing: quoteTiming(evidence.startMs, evidence.endMs),
    })));

  return {
    available: true,
    blocked: false,
    summary: input.assessment.summary ?? '',
    quotes,
    notEnoughEvidence: competencies.filter((c) => c.notEnoughEvidence).map((c) => c.name),
    href,
    note: '',
    evidenceNote: EVIDENCE_NOTE,
  };
}

function buildDecision(input: JourneyInput, state: ColumnState, selected: SelectedInterview): DecisionColumn {
  const { pipeline } = input;
  const meta = selected.meta;

  const humanNotes: JourneyHumanNote[] = (pipeline?.rounds ?? [])
    .filter((r) => r.conductedBy === 'HUMAN' && r.status === 'COMPLETED')
    .map((round) => {
      const written = (round.notes ?? '').trim();
      return {
        roundId: round.id,
        stageLabel: labelOf(pipeline, round.stageKey),
        interviewers: round.interviewers,
        completedAt: round.completedAt ?? null,
        notes: written.length > 0 ? written : PURGED_NOTES,
        retained: written.length > 0,
      };
    });

  return {
    key: 'decision',
    step: 4,
    title: 'Decision & evidence',
    icon: 'evidence',
    state,
    assessment: buildAssessmentView(input, input.assessment?.id ?? meta?.assessmentId ?? null),
    recommendation: input.assessment?.recommendation ?? meta?.recommendation ?? null,
    humanNotes,
    humanNotesNote: 'Written by the interviewers after each human round. Questor does not transcribe those rounds.',
    decision: {
      recorded: pipeline?.status === 'DECIDED',
      value: pipeline?.status === 'DECIDED' ? pipeline.decision : null,
      reason: pipeline?.decisionReason ?? '',
      stageLabel: pipeline?.decidedAtStageKey ? labelOf(pipeline, pipeline.decidedAtStageKey) : null,
      decidedAt: pipeline?.decidedAt ?? null,
      outcome: pipeline ? pipelineOutcome(pipeline.stages, pipeline).text : null,
    },
    evidenceGaps: input.missingEvidence,
    candidateFeedback: buildFeedbackView(input.candidateFeedback),
  };
}

// ---------------------------------------------------------------------------

/** Arrange one candidate's server data as the four journey columns, in order. */
export function buildJourney(input: JourneyInput): CandidateJourney {
  const states = columnStates(input.pipeline);
  const selected = selectAiInterview(input);
  const onboard = buildOnboard(input, states[0]);
  const aiInterview = buildAiInterview(input, states[1], selected);
  const schedule = buildSchedule(input, states[2]);
  const decision = buildDecision(input, states[3], selected);

  return {
    title: journeyTitle(input.role?.title ?? null),
    columns: [onboard, aiInterview, schedule, decision],
    onboard,
    aiInterview,
    schedule,
    decision,
  };
}
