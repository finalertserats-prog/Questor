import { nanoid } from 'nanoid';
import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import type { InterviewPlan, RoleSuccessProfile, TurnRecord } from '../domain/types.js';
import { assertTransition } from '../domain/stateMachine.js';
import { directorDecide } from '../engines/interviewDirector.js';
import { nextUtterance, type AgentUtterance, type Persona } from '../engines/conversationRuntime.js';
import { detectInjection } from '../engines/policyEngine.js';
import { evaluate } from '../engines/evaluator.js';
import { roleTechStack } from '../services/roleTechStack.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import { emitEvent } from '../services/webhooks.js';
import { logAudit } from '../services/audit.js';
import { replanFromLatestScorecard } from '../services/interviewReplan.js';
import { lockSession, type TransactionClient } from '../services/sessionLock.js';
import { enqueueAutoFeedback } from '../services/autoFeedback.js';
import { notifyHiringTeam } from '../services/hiringTeamNotice.js';
import { notePipelineEvent } from '../services/pipelineAutonomy.js';
import { HttpError } from '../middleware/index.js';
import { logger } from '../logger.js';
import { assertAcceptingNewInterviews } from '../services/drainState.js';
import { noteSessionActivity } from './liveSessions.js';
import { OBSERVER_NOTICE, hasObserverNotice } from '../services/observerPolicy.js';
import { openingQuestion } from '../engines/openingModel.js';
import { currentSitting } from '../engines/conversationModel.js';
import { traceServing, type ServedCall } from '../providers/llm/servingTrace.js';
import { servingMeta } from '../services/interviewServing.js';
import { anchorsFor, recordLibraryUsage } from '../library/usage.js';

const AVG_MS_PER_TURN = 40_000; // virtual pacing when real timestamps are absent

// Every candidate turn costs a paid LLM call, and the portal turn endpoint is
// unauthenticated by design. Without a ceiling, anyone holding a valid invite
// link can loop it forever. A 45-minute interview lands near 60-80 turns, so
// 200 is unreachable in good faith but bounds the spend and the row count.
const MAX_TURNS_PER_SESSION = 200;

// Enforced HERE rather than only in the portal route, because Socket.IO is the
// primary interview transport and Express middleware never runs on it. The
// route-level 4000-char cap therefore protected the fallback path while the
// primary one accepted up to socket.io's 1MB default buffer — roughly 200MB of
// billable LLM input per valid invitation. Every transport inherits this.
const MAX_ANSWER_CHARS = 4000;

// States in which the transcript is still being written. Outside these the
// assessment has been generated (and possibly human-reviewed), so accepting a
// turn would silently rewrite the evidence behind a completed hiring decision.
const LIVE_STATES = ['ASSESSING', 'CANDIDATE_QUESTIONS'];

// Pre-interview states from which "start" may legitimately converge to live.
// Anything else — finished, closed, cancelled, withdrawn, handed to a human —
// must not be restartable.
const STARTABLE_STATES = [
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING',
  'CONNECTING', 'DISCLOSURE', 'CONSENTED', 'WARMUP',
];

// Once an assessment exists the interview is over. Re-running finalisation
// minted a fresh assessment version and new report/transcript artifacts every
// time it was called, which is both evidence tampering and cost amplification.
const FINALIZABLE_STATES = [...LIVE_STATES, 'CLOSING', 'PROCESSING'];

// Terminal status stamped on an invitation once its interview finalises, so the
// same link cannot restart or extend a finished interview.
export const INVITATION_CONSUMED = 'consumed';

export interface AgentTurnOut {
  turnId: string;
  index: number;
  text: string;
  competencyId: string;
  kind: string;
  state: string;
  done: boolean;
  /**
   * The candidate asked to stop, as opposed to reaching the end.
   *
   * Both end the session, but only one of them may be assessed. Callers must
   * branch on this rather than on `done`: a withdrawn interview that goes
   * through finalisation produces a score from a partial transcript, and the
   * candidate was just told nothing they said would count against them.
   */
  withdrawn: boolean;
}

async function loadContext(sessionId: string) {
  const session = await prisma.interviewSession.findUnique({
    where: { id: sessionId },
    include: { plan: true, scorecard: true, candidate: true, role: true, turns: { orderBy: { index: 'asc' } } },
  });
  if (!session) throw new Error('Session not found');
  if (!session.plan) throw new Error('Session has no interview plan');
  // Plan and rubric are what the interviewer asks from and the evaluator scores
  // against. Defaulting either to {} ran an interview with nothing to ask and
  // nothing to score, so an unreadable row stops here — before any state
  // transition, so nothing is left half-moved.
  const plan = parseJsonStrict<InterviewPlan>(session.plan.planJson, { model: 'InterviewPlanVersion', id: session.plan.id, field: 'planJson' });
  const profile = parseJsonStrict<RoleSuccessProfile>(session.scorecard.profileJson, { model: 'RoleScorecardVersion', id: session.scorecard.id, field: 'profileJson' });
  // No invented name: a record without one is spoken for as "your AI
  // interviewer". Tone keeps its long-standing default.
  const stored = parseJsonOptional<Partial<Persona>>(session.personaJson, {}, { model: 'InterviewSession', id: session.id, field: 'personaJson' });
  const persona: Persona = { name: typeof stored.name === 'string' ? stored.name : '', tone: stored.tone ?? 'warm' };
  const turns: TurnRecord[] = session.turns.map((t) => {
    const stored = t.speaker === 'agent' ? storedUtterance(t.metaJson) : {};
    return {
      id: t.id, index: t.index, speaker: t.speaker as TurnRecord['speaker'], text: t.text,
      startMs: t.startMs, endMs: t.endMs, confidence: t.confidence, competencyId: t.competencyId,
      ...stored,
    };
  });
  return { session, plan, profile, persona, turns };
}

/**
 * The utterance kind and bare question an agent turn was stored with. Lets the
 * conversation tell a question from a pause or a re-ask of it, and put the
 * question again without its lead-in. A damaged or absent record reads as
 * neither, which the conversation treats as an ordinary question.
 */
function storedUtterance(metaJson: string): Pick<TurnRecord, 'kind' | 'question' | 'sittingClosed' | 'libraryEntryId' | 'form' | 'rungIndex'> {
  try {
    const meta = JSON.parse(metaJson) as { kind?: unknown; question?: unknown; sittingClosed?: unknown; libraryEntryId?: unknown; form?: unknown; rungIndex?: unknown };
    return {
      ...(typeof meta.kind === 'string' ? { kind: meta.kind } : {}),
      ...(typeof meta.question === 'string' ? { question: meta.question } : {}),
      ...(meta.sittingClosed === true ? { sittingClosed: true } : {}),
      // A question drawn on a library entry: which one, and the form it was tagged with.
      ...(typeof meta.libraryEntryId === 'string' ? { libraryEntryId: meta.libraryEntryId } : {}),
      ...(typeof meta.form === 'string' ? { form: meta.form } : {}),
      ...(typeof meta.libraryEntryId === 'string' && Number.isInteger(meta.rungIndex) ? { rungIndex: meta.rungIndex as number } : {}),
    };
  } catch {
    return {};
  }
}

function elapsedMinutes(turns: TurnRecord[]): number {
  const maxEnd = turns.reduce((m, t) => Math.max(m, t.endMs), 0);
  if (maxEnd > 0) return maxEnd / 60000;
  return (turns.length * AVG_MS_PER_TURN) / 60000;
}

// The session row lock lives in services/sessionLock.ts, shared with the
// start-time re-plan so a re-plan and an append never decide side by side.
const lockSessionForAppend = lockSession;

/** A check made under the append lock; throwing refuses the append. */
type AppendGuard = (tx: TransactionClient, tail: { id: string; index: number } | null) => Promise<void> | void;

/** A unique-constraint violation, however the driver reports it. */
function isDuplicateIndex(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * Append a turn, allocating its index atomically.
 *
 * Callers used to pass `turns.length`, computed from a read that had already
 * happened — so two requests arriving together (the socket and the HTTP
 * fallback, or one candidate on two devices) both inserted at the same index
 * and the canonical transcript order became row insertion order. The index is
 * now read and written inside one transaction, and the unique constraint on
 * (sessionId, index) is what catches the interleaving the transaction does not:
 * the loser retries once against the newly-current tail.
 *
 * `guard`, when given, runs inside that transaction after the tail is read and
 * may throw to refuse the append.
 */
async function appendTurn(sessionId: string, turn: Omit<TurnRecord, 'id' | 'index'>, meta?: Record<string, unknown>, guard?: AppendGuard): Promise<TurnRecord> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rec = await prisma.$transaction(async (tx) => {
        await lockSessionForAppend(tx, sessionId);
        const tail = await tx.turn.findFirst({
          where: { sessionId }, orderBy: { index: 'desc' }, select: { id: true, index: true },
        });
        // Decided under the same lock as the write, so "the transcript is still
        // what I read" cannot change between the check and the insert.
        if (guard) await guard(tx, tail);
        return tx.turn.create({
          data: {
            id: nanoid(10), sessionId, index: (tail?.index ?? -1) + 1, speaker: turn.speaker, text: turn.text,
            startMs: turn.startMs, endMs: turn.endMs, confidence: turn.confidence, competencyId: turn.competencyId ?? '',
            ...(meta ? { metaJson: JSON.stringify(meta) } : {}),
          },
        });
      });
      return { id: rec.id, index: rec.index, speaker: rec.speaker as TurnRecord['speaker'], text: rec.text, startMs: rec.startMs, endMs: rec.endMs, confidence: rec.confidence, competencyId: rec.competencyId };
    } catch (err) {
      if (!isDuplicateIndex(err)) throw err;
      lastErr = err;
    }
  }
  // Two collisions in a row means sustained concurrent writing on one session,
  // which is not a transcript anyone should be appending to blindly.
  logger.error({ sessionId }, 'Could not allocate a turn index after a retry');
  throw lastErr;
}

export async function setState(sessionId: string, from: string, to: string) {
  assertTransition(from, to);
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: to } });
}

/**
 * Move the session only if it is still in `from`, reporting whether it applied.
 *
 * `setState` validates a state that was read earlier and then updates by id, so
 * two callers racing the same transition both pass the check and both write.
 * Matching on the state in the WHERE clause makes the update itself the
 * decision: at most one caller can move a session out of a given state, and the
 * loser is told so rather than quietly proceeding on a stale assumption.
 */
export async function transitionIfInState(sessionId: string, from: string, to: string): Promise<boolean> {
  assertTransition(from, to);
  const { count } = await prisma.interviewSession.updateMany({
    where: { id: sessionId, state: from },
    data: { state: to },
  });
  return count > 0;
}

/**
 * The transcript gained a turn between reading it and writing the reply to it.
 * Internal: callers catch it and hand back whatever is now pending.
 */
class TranscriptMovedError extends Error {
  constructor() { super('The transcript changed while a reply was being produced'); }
}

/**
 * Produce and persist the next agent turn given the current transcript.
 *
 * The reply is written only if the transcript's last turn is still the one it
 * was generated from. Two writers — a reload's Continue racing the original
 * answer, two tabs, two starts — otherwise each put a reply on the record and
 * the candidate was asked two things at once. `requireTailId`, when given, also
 * refuses before any model call if the transcript has already moved on.
 */
async function produceAgentTurn(sessionId: string, requireTailId?: string | null): Promise<AgentTurnOut> {
  noteSessionActivity(sessionId);
  const { session, plan, profile, persona, turns: allTurns } = await loadContext(sessionId);
  const readTailId = allTurns.length > 0 ? allTurns[allTurns.length - 1].id : null;
  if (requireTailId !== undefined && requireTailId !== readTailId) throw new TranscriptMovedError();
  // A postponed interview that was re-invited starts again from the greeting;
  // the earlier sitting stays on the record for reviewers.
  const turns = currentSitting(allTurns);
  const signal = directorDecide({ plan, turns, elapsedMinutes: elapsedMinutes(turns) });
  // The AI disclosure is shown and agreed to on the consent screen before the
  // interview; the consent record is what proves it. A damaged record stops
  // the interview here rather than letting it run with nothing on file saying
  // the candidate was told.
  const consent = parseJsonStrict<{ disclosureText?: string }>(session.consentJson, { model: 'InterviewSession', id: session.id, field: 'consentJson' });
  // The opening greets the candidate by first name and names the role. The
  // observation notice is still said aloud when the consent screen carried it:
  // that spoken turn is the server-side proof live observation depends on.
  // Traced so the turn records which model layer wrote it (degraded mode for
  // reviewers); nothing is recorded unless the local fallback chain ran.
  const { result: utter, served } = await traceServing(() => nextUtterance({
    plan, signal, turns, role: profile, persona, sessionId,
    candidateName: session.candidate.fullName, roleTitle: session.role.title, techStack: roleTechStack(session.role),
    observerNotice: hasObserverNotice(consent.disclosureText ?? '') ? OBSERVER_NOTICE : undefined,
    candidateLeft: leftByButton(session.turns[session.turns.length - 1]),
  }));

  const lastEnd = allTurns.reduce((m, t) => Math.max(m, t.endMs), 0);
  const agentTurn = await appendTurn(sessionId, {
    speaker: 'agent', text: utter.text,
    startMs: lastEnd, endMs: lastEnd + 12_000, confidence: 1, competencyId: utter.competencyId,
    // Recorded so a repeated start can hand back the turn that already exists
    // instead of guessing what kind of utterance it was.
  }, agentTurnMeta(utter, served), (_tx, tail) => {
    if ((tail?.id ?? null) !== readTailId) throw new TranscriptMovedError();
  });

  // 'close' invites the candidate's own questions and must stay open for their
  // reply; the session ends on the sign-off that follows it.
  // 'withdrawn' ends the session like a sign-off: the candidate asked to stop,
  // so the next thing that happens must not be another question.
  const done = ENDING_KINDS.includes(utter.kind);
  // Safety stops, withdrawals and postponements all end the conversation
  // because the person asked to — none is a completed interview, and none may
  // be scored.
  const withdrawn = WITHDRAWN_KINDS.includes(utter.kind);
  return {
    turnId: agentTurn.id, index: agentTurn.index, text: utter.text, competencyId: utter.competencyId,
    kind: utter.kind, state: session.state, done, withdrawn,
  };
}

/**
 * What an agent turn stores in Turn.metaJson. Two separate records share it:
 * which library rung the turn drew on (libraryEntryId, form, rungIndex,
 * rungMove) and which model layer wrote it (`serving`, degraded mode). Their
 * keys are distinct and neither is written anywhere else, so one never
 * overwrites the other. With both off it is { kind, question } as it always was.
 */
export function agentTurnMeta(utter: AgentUtterance, served: readonly ServedCall[]): Record<string, unknown> {
  return {
    kind: utter.kind,
    ...(utter.question ? { question: utter.question } : {}),
    ...libraryMeta(utter),
    ...servingMeta(served),
  };
}

/**
 * What a library-drawn turn records about its source: the entry, its form tag
 * and the rung path (library/usage.ts reads them back). Empty for every other
 * turn, so an interview planned without the library stores what it always did.
 */
function libraryMeta(utter: AgentUtterance): Record<string, unknown> {
  if (!utter.libraryEntryId) return {};
  return {
    libraryEntryId: utter.libraryEntryId,
    ...(utter.form ? { form: utter.form } : {}),
    ...(utter.rungIndex !== undefined ? { rungIndex: utter.rungIndex } : {}),
    ...(utter.rungMove ? { rungMove: utter.rungMove } : {}),
  };
}

/** How a Leave-button turn is marked on the record and shown in the transcript. */
export const LEAVE_SOURCE = 'leave_button';
export const LEAVE_MARKER = '(Left the interview)';

/** Whether a stored turn is the candidate pressing Leave. */
export function leftByButton(turn: { speaker: string; metaJson: string } | undefined): boolean {
  if (!turn || turn.speaker !== 'candidate') return false;
  try {
    return (JSON.parse(turn.metaJson) as { source?: unknown }).source === LEAVE_SOURCE;
  } catch {
    return false;
  }
}

/**
 * Close an interview the candidate chose to leave, WITHOUT assessing it.
 *
 * The alternative — running finalisation — produced, on a real withdrawal:
 * state REVIEW_READY, one assessment, "CONSIDER 0/100". A person who exercised
 * their right to stop appeared in the recruiter's queue looking like a bad
 * candidate rather than an incomplete interview, moments after being told
 * nothing they said would count against them. Scoring a partial transcript is
 * not merely unfair, it is worse than silence: 0/100 reads as a judgement.
 *
 * The transcript is retained — the candidate may want to resume, and the
 * accommodation follow-up needs the context — but no AssessmentVersion is
 * created, so there is nothing for a reviewer to anchor on.
 */
export async function withdrawInterview(sessionId: string, reason: EndReason): Promise<void> {
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { tenantId: true, state: true } });
  if (!session) return;
  if (['CANDIDATE_WITHDREW', 'POLICY_STOP', 'CLOSED', 'RESCHEDULE_REQUIRED'].includes(session.state)) return; // already closed
  if (reason === 'candidate_postponed') {
    await postponeInterview(sessionId, session);
    return;
  }

  await prisma.interviewSession.update({
    where: { id: sessionId },
    data: { state: reason === 'safety_stop' ? 'POLICY_STOP' : 'CANDIDATE_WITHDREW', completedAt: new Date() },
  });
  // The link is not consumed: a candidate who stopped may be invited back, and
  // burning it would force a recruiter to reissue just to say "take your time".
  await logAudit({
    tenantId: session.tenantId, actorType: 'user', actorId: 'candidate',
    action: reason === 'safety_stop' ? 'interview.safety_stopped' : 'interview.withdrawn',
    entityType: 'InterviewSession', entityId: sessionId,
    after: { assessed: false, note: 'Ended at the candidate\'s request; no assessment generated.' },
  });
  logger.info({ sessionId, reason }, 'Interview ended at candidate request — not assessed');
}

/**
 * Why an interview the candidate ended was closed, from the kind of the
 * interviewer's last turn. Every caller that closes a withdrawn turn asks this
 * rather than branching on the kind itself, so a new way of ending cannot be
 * filed under the wrong one.
 */
export type EndReason = 'candidate_withdrew' | 'safety_stop' | 'candidate_postponed';

export function endReasonFor(kind: string): EndReason {
  if (kind === 'safety') return 'safety_stop';
  if (kind === 'postponed') return 'candidate_postponed';
  return 'candidate_withdrew';
}

/**
 * The candidate asked to do the interview another time.
 *
 * RESCHEDULE_REQUIRED rather than CANDIDATE_WITHDREW or INCOMPLETE, because it
 * says exactly what happened and exactly what HR should do next: the candidate
 * still wants the interview, just not now. It is the state the recruiter's
 * existing re-invite accepts (routes/interviews.ts inviteSession), the
 * dashboard already files it under "Invited / scheduled", and the candidate's
 * link then reads "Your interview is being rescheduled". CANDIDATE_WITHDREW
 * would tell a reviewer they walked away; INCOMPLETE says nobody knows why it
 * stopped, and its retake counts against the attempt cap. Not scored, and the
 * invitation is not burned.
 */
async function postponeInterview(sessionId: string, session: { tenantId: string; state: string }): Promise<void> {
  assertTransition(session.state, 'RESCHEDULE_REQUIRED');
  const moved = await transitionIfInState(sessionId, session.state, 'RESCHEDULE_REQUIRED');
  if (!moved) return; // another request settled it first
  await logAudit({
    tenantId: session.tenantId, actorType: 'user', actorId: 'candidate',
    action: 'interview.candidate_postponed',
    entityType: 'InterviewSession', entityId: sessionId,
    after: { assessed: false, note: 'Candidate asked to do this later. No assessment generated — offer a new time.' },
  });
  logger.info({ sessionId }, 'Interview postponed at candidate request — not assessed, awaiting a new time');
}

/** One line of the conversation as the candidate may see it: who spoke, and what. */
export interface TranscriptLine {
  speaker: 'agent' | 'candidate';
  text: string;
}

/** What a start hands the room: the turn to put to the candidate, and the context around it. */
export interface StartOutcome {
  turn: AgentTurnOut;
  /** True when the session was already live and nothing new was written. */
  resumed: boolean;
  /**
   * The conversation on record, oldest first, ending with `turn` — or, when
   * `awaitingReply`, with the candidate's unanswered answer. Speaker and text
   * only: scores, flags, competencies and timings are for reviewers.
   */
  history: TranscriptLine[];
  /** The last thing on record is the candidate's answer, and no reply to it exists. */
  awaitingReply: boolean;
  /**
   * How long ago that unanswered answer arrived. A recent one usually means the
   * reply is still being produced by the request that stored it, so the room
   * waits for it rather than inviting the candidate to carry on over the top.
   */
  pendingAnswerAgeMs?: number;
  /**
   * Where the room's answer clock resumes, in the same clock as turn
   * startMs/endMs. See resumeClockMs.
   */
  elapsedMs: number;
}

/** Agent turn kinds after which the conversation is over (see produceAgentTurn). */
const ENDING_KINDS: readonly string[] = ['signoff', 'safety', 'withdrawn', 'postponed'];
const WITHDRAWN_KINDS: readonly string[] = ['withdrawn', 'safety', 'postponed'];

/** A beat between the last thing on record and the first thing after a rejoin. */
const RESUME_GAP_MS = 1_000;
/**
 * Far past any real interview, and far enough under the portal's 24-hour
 * ceiling on answer stamps that answers after a rejoin always fit under it.
 */
const MAX_RESUME_CLOCK_MS = 6 * 60 * 60 * 1000;
/** Re-reads of start inside this window are the same rejoin (see recordRejoin). */
const REJOIN_AUDIT_WINDOW_MS = 60_000;

/**
 * Where a rejoined room's clock starts: just after the last stamp on record.
 *
 * Deliberately NOT wall-clock time since the start. The director paces the
 * interview from these stamps (elapsedMinutes), so twenty minutes spent
 * reconnecting would otherwise be spent out of the candidate's interview. The
 * time away is recorded separately, for reviewers, as 'interview.rejoined'.
 *
 * Capped so one absurd stamp — a browser can send up to 24 hours — cannot push
 * every later answer past the portal's limit and have them all refused. Past
 * the cap the stamps stop being monotonic, which only happens after a stamp
 * that was already meaningless.
 */
function resumeClockMs(lastEndMs: number): number {
  return Math.min(lastEndMs + RESUME_GAP_MS, MAX_RESUME_CLOCK_MS);
}

function toTranscript(turns: { speaker: string; text: string }[]): TranscriptLine[] {
  return turns
    .filter((t): t is TranscriptLine => t.speaker === 'agent' || t.speaker === 'candidate')
    .map((t) => ({ speaker: t.speaker, text: t.text }));
}

/**
 * Where a live interview stands, read without writing anything.
 *
 * The turn handed back is the latest agent turn: the question the candidate
 * still owes an answer to. When the last row is the candidate's own answer —
 * stored, but the reply not (yet) — the reply is NOT generated here. Doing so
 * would make start a paid LLM call, and it would race the original request if
 * that is still in flight. Instead the question that answer was for is handed
 * back with `awaitingReply` and the answer's age: the room waits briefly for
 * the in-flight reply, then offers Continue (continueAfterAnswer), which
 * produces it under the same guard as every other reply.
 *
 * Returns null when a live session somehow has no agent turn yet.
 */
/**
 * The rows of the sitting now in progress.
 *
 * A postponed interview that is re-invited keeps the earlier sitting on record.
 * The re-invite marks that sitting's sign-off closed (closeSittingForReinvite),
 * and only a closed sign-off is a boundary: a sign-off that has just been
 * said, while the session is still settling into RESCHEDULE_REQUIRED, is this
 * sitting's own ending and stays the outcome a repeat read hands back. A
 * marker on the row, not a timestamp, so no two clocks have to agree.
 */
function currentSittingRows<T extends { speaker: string; metaJson: string | null }>(rows: readonly T[]): T[] {
  let from = 0;
  rows.forEach((r, i) => {
    if (r.speaker !== 'agent') return;
    const meta = parseJsonOptional<{ kind?: unknown; sittingClosed?: unknown }>(r.metaJson ?? '{}', {}, { model: 'Turn', id: 'row', field: 'metaJson' });
    if (meta.kind === 'postponed' && meta.sittingClosed === true) from = i + 1;
  });
  return rows.slice(from);
}

/**
 * Close the sitting a postponed session ended, so its sign-off is no longer
 * "the question still owed an answer" once the candidate is invited again.
 * Stamped by the re-invite (closeSittingForReinvite) and again, as the
 * safety net for any other way back to a startable state, by the start
 * that claims the session — under the same transaction as the claim.
 */
async function closePreviousSitting(db: TransactionClient | typeof prisma, sessionId: string): Promise<void> {
  const last = await db.turn.findFirst({ where: { sessionId, speaker: 'agent' }, orderBy: { index: 'desc' }, select: { id: true, metaJson: true } });
  if (!last) return;
  const meta = parseJsonOptional<Record<string, unknown>>(last.metaJson ?? '{}', {}, { model: 'Turn', id: last.id, field: 'metaJson' });
  if (meta.kind !== 'postponed' || meta.sittingClosed === true) return;
  await db.turn.update({ where: { id: last.id }, data: { metaJson: JSON.stringify({ ...meta, sittingClosed: true }) } });
}

/** The re-invite's explicit close, before the session leaves RESCHEDULE_REQUIRED. */
export async function closeSittingForReinvite(sessionId: string): Promise<void> {
  await closePreviousSitting(prisma, sessionId);
}

async function recordedOutcome(sessionId: string, state: string, resumed: boolean): Promise<StartOutcome | null> {
  const turns = await prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' } });
  // While the session is live, only this sitting's turns can be "the question
  // still owed an answer": a postponed interview that was re-invited keeps
  // the earlier sitting on record, and its sign-off must not be handed back
  // as the start of this one. Once the session has ended, the sign-off that
  // ended it is exactly what a repeat read should get.
  const candidates = LIVE_STATES.includes(state) ? currentSittingRows(turns) : turns;
  const pending = [...candidates].reverse().find((t) => t.speaker === 'agent');
  if (!pending) return null;
  const kindValue = parseJsonOptional<{ kind?: unknown }>(pending.metaJson, {}, { model: 'Turn', id: pending.id, field: 'metaJson' }).kind;
  const kind = typeof kindValue === 'string' ? kindValue : 'question';
  const last = turns[turns.length - 1];
  const awaitingReply = last?.speaker === 'candidate';
  const lastEnd = turns.reduce((m, t) => Math.max(m, t.endMs), 0);
  return {
    turn: {
      turnId: pending.id, index: pending.index,
      // A rejoin puts the opening's question again, not its greeting; the
      // history below still shows the greeting as it was said. The room's
      // speech of this text is allowed because it is the tail of the stored
      // turn (routes/portal.ts /speak).
      text: resumed && kind === 'opening' ? openingQuestion(pending.text) : pending.text,
      competencyId: pending.competencyId,
      kind, state,
      // Mirrors produceAgentTurn, so a rejoin after the sign-off ends the room
      // exactly as the sign-off itself would have.
      done: ENDING_KINDS.includes(kind),
      withdrawn: WITHDRAWN_KINDS.includes(kind),
    },
    resumed,
    history: toTranscript(turns),
    awaitingReply,
    ...(awaitingReply ? { pendingAnswerAgeMs: Math.max(0, Date.now() - last.createdAt.getTime()) } : {}),
    elapsedMs: resumed ? resumeClockMs(lastEnd) : 0,
  };
}

/**
 * Produce the next agent turn, or — if another writer got there first — hand
 * back what is now pending. `produced` says which, so only the writer that
 * actually wrote a sign-off goes on to finalise.
 */
async function produceOrCurrent(sessionId: string, requireTailId?: string | null): Promise<{ turn: AgentTurnOut; produced: boolean }> {
  try {
    return { turn: await produceAgentTurn(sessionId, requireTailId), produced: true };
  } catch (err) {
    if (!(err instanceof TranscriptMovedError)) throw err;
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true } });
    const current = session ? await recordedOutcome(sessionId, session.state, false) : null;
    if (!current) throw new HttpError(409, 'This interview changed while we were replying. Please reload the page.', 'transcript_moved');
    return { turn: current.turn, produced: false };
  }
}

/**
 * Whether this session carries a consent record.
 *
 * `consentedAt` is the field every consent path stamps (portal, seed, sim), and
 * its presence is what distinguishes "the candidate agreed" from "a disclosure
 * was drafted for them". A session created by the recruiter routes carries the
 * disclosure text but no `consentedAt` until the candidate accepts it.
 */
export function hasRecordedConsent(session: { id: string; consentJson: string }): boolean {
  // Unreadable is corruption, not "no consent": the candidate may well have
  // agreed, and sending them back to agree again would write over the only
  // record of what they agreed to.
  const consent = parseJsonStrict<{ consentedAt?: unknown }>(session.consentJson, { model: 'InterviewSession', id: session.id, field: 'consentJson' });
  return typeof consent.consentedAt === 'string' && consent.consentedAt.length > 0;
}

/** Begin the assessed conversation: move to ASSESSING and emit the opening. */
export async function startInterview(sessionId: string): Promise<AgentTurnOut> {
  return (await startOrResumeInterview(sessionId)).turn;
}

/**
 * Start the interview, or resume it when it is already live.
 *
 * The room calls start on every entry — first join, reload, reconnect, return
 * through the invitation link — so a live session is the common case, not an
 * edge one. See resumeLiveInterview for what a resume hands back.
 */
export async function startOrResumeInterview(sessionId: string): Promise<StartOutcome> {
  const { session, turns: turnsAtStart } = await loadContext(sessionId);
  // Usually empty. Not always: a session retried after a technical failure
  // starts again with its earlier turns on record.
  const tailAtStart = turnsAtStart.length > 0 ? turnsAtStart[turnsAtStart.length - 1].id : null;
  // Starting an interview that is already live is a repeat, not a new start.
  // A refresh, a double-tap, or a socket reconnect racing the portal fallback
  // used to append a second opening: another paid LLM call, another
  // 'interview.started' event, and a transcript whose canonical order contains
  // two greetings — the interviewer introducing itself again mid-interview.
  if (LIVE_STATES.includes(session.state)) {
    const resumed = await recordedOutcome(sessionId, session.state, true);
    if (resumed) {
      // A candidate coming back mid-interview is live work for the drain.
      noteSessionActivity(sessionId);
      await recordRejoin(session.tenantId, sessionId);
      return resumed;
    }
  }
  // Pre-live states (invite/accept/consent/ready-check) are governed by the
  // portal + recruiter flows. "Start" converges every valid entry point to the
  // live ASSESSING state; the opening disclosure/warmup turns are still emitted
  // by the conversation runtime so the candidate always gets them.
  // Only states that precede the interview may be converged to live. Previously
  // this reset ANY state, so REVIEW_READY / HUMAN_REVIEWED / CLOSED / CANCELLED
  // / MANUAL_HANDOFF could all be dragged back to ASSESSING — reopening a
  // finished interview and letting new turns rewrite the evidence behind a
  // decision a human had already made. That also defeated the turn-state guard
  // below, since the guard only checks the state this function could reset.
  if (!LIVE_STATES.includes(session.state)) {
    // Consent is checked before the state converges, not after. Without this,
    // any caller holding a valid invitation could skip the disclosure entirely
    // and still reach a scored assessment: a transcript and a recommendation
    // would exist with nothing on the session saying the person agreed to
    // either. That record is the first thing a GDPR Art. 22 or LL144 enquiry
    // asks for, and it cannot be reconstructed afterwards.
    if (!hasRecordedConsent(session)) {
      throw new HttpError(409, 'This interview cannot start until the disclosure has been read and consent recorded. Please go back to your invitation link and accept the disclosure first.');
    }
    if (!STARTABLE_STATES.includes(session.state)) {
      // Candidate-facing. An internal state name reads as a crash to the person
      // it is shown to, and MANUAL_HANDOFF in particular means "a human is
      // coming" — which is reassuring information delivered as an error.
      throw new HttpError(409, session.state === 'MANUAL_HANDOFF'
        ? 'You asked to be interviewed by a person instead. Our team has your request and will be in touch — there is nothing more to do here. If you would rather continue with the AI interview after all, reply to your invitation email and we will reopen it.'
        : 'This interview is not open right now. If you think that is wrong, reply to your invitation email and we will look into it.');
    }
    // Checked here, in the engine, so every transport refuses alike: a process
    // that is shutting down must not begin an interview it will abandon. The
    // session is left exactly as it was, so the retry after restart works.
    assertAcceptingNewInterviews();
    // Conditional on the state we read, so of two starts racing (two tabs, the
    // socket and the portal fallback) exactly one begins the interview. The
    // other joins it below instead of announcing and opening it a second time.
    // The claim and the closing of any earlier sitting commit together: a
    // start that loses the claim reads the transcript afterwards and must see
    // the previous sign-off already marked, or it would hand it back as this
    // sitting's opening. From a pre-live state, any postponement on record is
    // by definition a previous sitting's, however the session was reopened.
    const claimed = await prisma.$transaction(async (tx) => {
      await lockSession(tx, sessionId);
      const { count } = await tx.interviewSession.updateMany({
        where: { id: sessionId, state: session.state },
        data: { state: 'ASSESSING', startedAt: new Date() },
      });
      if (count === 0) return false;
      await closePreviousSitting(tx, sessionId);
      return true;
    });
    if (!claimed) return joinRacingStart(sessionId);
    // Only the start that claimed the session gets here, so the plan is
    // rebuilt at most once: the scorecard approved since this interview was
    // set up is the one it is asked and scored against.
    await replanFromLatestScorecard(sessionId);
  } else {
    // Live but with no opening on record: a start that failed after claiming
    // the session. The re-plan it may not have reached runs here again; it is
    // a no-op once done.
    await replanFromLatestScorecard(sessionId);
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { startedAt: new Date() } });
  }
  // Only onto the transcript as it stood when this start began: if a racing
  // start's opening landed first, this one is discarded and theirs handed back.
  const { turn, produced } = await produceOrCurrent(sessionId, tailAtStart);
  // Announced by whichever start actually put the opening on record — not by
  // the claim, which a retry entering the live branch above would announce a
  // second time while the first start was still generating.
  if (produced) await announceStart(session.tenantId, sessionId);
  const turns = await prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' }, select: { speaker: true, text: true } });
  return { turn, resumed: false, history: toTranscript(turns), awaitingReply: false, elapsedMs: 0 };
}

/** The interview has begun: once per sitting, by the start that produced the opening. */
async function announceStart(tenantId: string, sessionId: string): Promise<void> {
  await logAudit({ tenantId, action: 'interview.started', entityType: 'InterviewSession', entityId: sessionId });
  await emitEvent(tenantId, 'interview.started', { sessionId });
}

/**
 * The start that lost the race: take the opening the winner produced, or
 * produce it if theirs has not landed.
 *
 * One read of the transcript both decides and anchors. Deciding on one read
 * and writing onto another let the winner's opening arrive in between, and
 * this start then appended a follow-up question straight after it — a
 * question the candidate was never given the chance to answer the greeting
 * before. (The session and its turns are also read by separate queries on
 * entry, so a caller can see a pre-live state next to a transcript that
 * already holds the opening; that is why the decision is made here, on the
 * transcript alone, and not on what the caller saw on the way in.)
 */
async function joinRacingStart(sessionId: string): Promise<StartOutcome> {
  const fresh = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true, tenantId: true } });
  if (!fresh || !LIVE_STATES.includes(fresh.state)) {
    throw new HttpError(409, 'This interview is not open right now. If you think that is wrong, reply to your invitation email and we will look into it.');
  }
  // Before reading the transcript: the plan the winner may still be rebuilding
  // is the one this opening must come from. The swap is conditional, so
  // whichever start gets there first rebuilds it and the other finds it done.
  await replanFromLatestScorecard(sessionId);
  const rows = await prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' }, select: { id: true, speaker: true, metaJson: true } });
  // The winner's opening is on record for this sitting: hand it back. A
  // previous sitting's sign-off does not count — see currentSittingRows.
  if (currentSittingRows(rows).some((r) => r.speaker === 'agent')) {
    const existing = await recordedOutcome(sessionId, fresh.state, false);
    if (existing) return existing;
  }
  // The winner is still generating. Racing it is safe: this start writes only
  // onto the transcript as read above, so if the winner's opening lands first
  // this one is refused and theirs handed back.
  const tail = rows.length > 0 ? rows[rows.length - 1].id : null;
  const { turn, produced } = await produceOrCurrent(sessionId, tail);
  if (produced) await announceStart(fresh.tenantId, sessionId);
  const turns = await prisma.turn.findMany({ where: { sessionId }, orderBy: { index: 'asc' }, select: { speaker: true, text: true } });
  return { turn, resumed: false, history: toTranscript(turns), awaitingReply: false, elapsedMs: 0 };
}

/**
 * The rejoin, for reviewers: when it happened and how long the candidate was
 * away. Kept out of the turn stamps on purpose — see resumeClockMs.
 */
async function recordRejoin(tenantId: string, sessionId: string): Promise<void> {
  // A room waiting for a reply re-reads start every couple of seconds; that is
  // one rejoin for the reviewer, not a line per re-read.
  const recent = await prisma.auditEvent.findFirst({
    where: { entityId: sessionId, action: 'interview.rejoined', createdAt: { gte: new Date(Date.now() - REJOIN_AUDIT_WINDOW_MS) } },
    select: { id: true },
  });
  if (recent) return;
  const last = await prisma.turn.findFirst({ where: { sessionId }, orderBy: { index: 'desc' }, select: { createdAt: true } });
  await logAudit({
    tenantId, action: 'interview.rejoined', entityType: 'InterviewSession', entityId: sessionId,
    after: { sinceLastTurnMs: last ? Math.max(0, Date.now() - last.createdAt.getTime()) : null },
  });
}

/**
 * The candidate's answer is on record but no reply to it is, and they have
 * nothing to add: produce that reply now.
 *
 * Only while the answer is still the last thing on record. If a reply already
 * exists — the original request finished, another tab pressed Continue — that
 * reply is handed back and nothing is written, so pressing it any number of
 * times, at once or in turn, puts one reply on the record.
 */
export async function continueAfterAnswer(sessionId: string): Promise<{ turn: AgentTurnOut; produced: boolean }> {
  const { session, turns } = await loadContext(sessionId);
  if (!LIVE_STATES.includes(session.state)) {
    throw new HttpError(409, 'This interview is no longer accepting answers.');
  }
  const last = turns[turns.length - 1];
  if (last?.speaker !== 'candidate') {
    const current = await recordedOutcome(sessionId, session.state, false);
    if (!current) throw new HttpError(409, 'This interview has not started yet.');
    return { turn: current.turn, produced: false };
  }
  if (turns.length >= MAX_TURNS_PER_SESSION) {
    throw new HttpError(429, 'This interview has reached its maximum length. Our team will follow up with you.');
  }
  return produceOrCurrent(sessionId, last.id);
}

/**
 * The sign-off already on record when this session ended because the
 * candidate pressed Leave; null for any other ending. Only a withdrawal whose
 * last candidate turn is the Leave marker, and whose last agent turn follows
 * it, counts — a session withdrawn some other way keeps refusing.
 */
async function repeatedLeave(
  sessionId: string,
  state: string,
  rows: { index: number; speaker: string; metaJson: string }[],
): Promise<AgentTurnOut | null> {
  if (state !== 'CANDIDATE_WITHDREW') return null;
  const lastCandidate = [...rows].reverse().find((t) => t.speaker === 'candidate');
  if (!lastCandidate || !leftByButton(lastCandidate)) return null;
  const recorded = await recordedOutcome(sessionId, state, false);
  if (!recorded || recorded.turn.index < lastCandidate.index || !recorded.turn.withdrawn) return null;
  return recorded.turn;
}

/** Ingest a candidate turn and return the next agent turn. */
export async function submitCandidateTurn(sessionId: string, text: string, timing?: { startMs?: number; endMs?: number; confidence?: number }): Promise<AgentTurnOut> {
  return (await submitCandidateAnswer(sessionId, text, timing)).turn;
}

/**
 * Ingest a candidate answer; `produced` is false when another writer's reply
 * was handed back instead of a new one (see produceOrCurrent).
 *
 * `inReplyTo` is the agent turn the candidate was looking at when they
 * answered. When it is not the newest agent turn the answer is refused as
 * stale: the interview moved on in another tab, or while a reload was showing
 * the previous question, and crediting the answer to a question the candidate
 * never saw puts false evidence in front of a reviewer. Optional, so the socket
 * and older rooms keep working unchanged.
 */
export async function submitCandidateAnswer(
  sessionId: string,
  text: string,
  timing?: { startMs?: number; endMs?: number; confidence?: number },
  opts?: { inReplyTo?: string; leaving?: boolean },
): Promise<{ turn: AgentTurnOut; produced: boolean }> {
  const { session, turns } = await loadContext(sessionId);
  // Leave is an action, not an answer: the record says so in neutral words
  // rather than quoting a sentence the candidate never said.
  const said = opts?.leaving ? LEAVE_MARKER : text;
  // All three guards run before any LLM call so an abusive caller never reaches
  // a billable path.
  if (said.length > MAX_ANSWER_CHARS) {
    logger.warn({ sessionId, chars: said.length }, 'Oversized candidate answer refused');
    throw new HttpError(400, `That answer is too long (limit ${MAX_ANSWER_CHARS} characters).`);
  }
  if (!LIVE_STATES.includes(session.state)) {
    // A Leave retried after it worked — the response was lost, or a second tab
    // pressed it — gets the sign-off it already received, not a refusal that
    // reads as though the candidate is still in an interview they left.
    const repeat = opts?.leaving ? await repeatedLeave(sessionId, session.state, session.turns) : null;
    if (repeat) return { turn: repeat, produced: false };
    throw new HttpError(409, 'This interview is no longer accepting answers.');
  }
  if (turns.length >= MAX_TURNS_PER_SESSION) {
    logger.warn({ sessionId, turns: turns.length }, 'Interview turn cap reached; refusing further turns');
    throw new HttpError(429, 'This interview has reached its maximum length. Our team will follow up with you.');
  }

  // Attribute this answer to whatever competency the last agent question targeted.
  const lastAgent = [...turns].reverse().find((t) => t.speaker === 'agent');
  const competencyId = lastAgent?.competencyId ?? '';
  const injection = opts?.leaving ? { injection: false, matched: [] as string[] } : detectInjection(said);
  const meta: Record<string, unknown> = {
    ...(opts?.leaving ? { source: LEAVE_SOURCE } : {}),
    ...(injection.injection ? { flags: ['prompt_injection'], injectionMatched: injection.matched, flaggedAt: new Date().toISOString() } : {}),
  };
  if (injection.injection) {
    // The interviewer never obeys the injected text, but a human reads the
    // report — the attempt itself is signal about the candidate and must
    // survive on the turn record rather than living only in the server log.
    logger.warn({ sessionId, index: turns.length, matched: injection.matched, textLength: said.length }, 'Prompt-injection attempt flagged on candidate turn');
  }
  const lastEnd = turns.reduce((m, t) => Math.max(m, t.endMs), 0);
  const answer = await appendTurn(sessionId, {
    speaker: 'candidate', text: said,
    startMs: timing?.startMs ?? lastEnd + 1000,
    endMs: timing?.endMs ?? lastEnd + 30_000,
    confidence: timing?.confidence ?? 0.9,
    competencyId,
  }, Object.keys(meta).length > 0 ? meta : undefined,
  async (tx) => {
    if (!opts?.inReplyTo) return;
    const newest = await tx.turn.findFirst({
      where: { sessionId, speaker: 'agent' }, orderBy: { index: 'desc' }, select: { id: true },
    });
    if (newest?.id !== opts.inReplyTo) {
      throw new HttpError(409, 'The interviewer has already moved on to the next question.', 'stale_question');
    }
  });
  // Only onto this answer: if a Continue from another tab already replied to
  // it, that reply is handed back rather than a second one written after it.
  return produceOrCurrent(sessionId, answer.id);
}

/** Close the interview, run the independent evaluator and persist the assessment. */
export async function finalizeInterview(
  sessionId: string,
  opts: { readonly partial?: boolean } = {},
): Promise<{ assessmentId: string }> {
  const { session, profile, turns, plan } = await loadContext(sessionId);
  if (!FINALIZABLE_STATES.includes(session.state)) {
    const existing = await prisma.assessmentVersion.findFirst({
      where: { sessionId }, orderBy: { version: 'desc' }, select: { id: true },
    });
    // Idempotent: hand back the assessment that already exists rather than
    // minting another version and another set of artifacts.
    if (existing) return { assessmentId: existing.id };
    throw new HttpError(409, `This interview cannot be finalised from its current state (${session.state}).`);
  }
  // Walk to PROCESSING one conditional step at a time. Every step applies only
  // if the session is still in the state it is being moved out of, so a second
  // finalisation arriving mid-flight cannot re-walk the same path — and, worse,
  // cannot drag a session that already reached REVIEW_READY back to
  // CANDIDATE_QUESTIONS, which an update-by-id did.
  await transitionIfInState(sessionId, 'ASSESSING', 'CANDIDATE_QUESTIONS');
  await transitionIfInState(sessionId, 'CANDIDATE_QUESTIONS', 'CLOSING');

  // The CLOSING -> PROCESSING claim is the mutex. Exactly one caller wins it,
  // and only the winner writes an assessment; the previous code let both
  // callers past, both read a count of zero, and both mint a version — leaving
  // the candidate with two scored records of one interview and a reviewer with
  // no way to tell which one a decision was made against.
  //
  // Deliberately NOT a database transaction around the whole body: evaluate()
  // is a network call to a paid provider, and holding a write lock open across
  // it would serialise every interview in the tenant behind the slowest vendor
  // response.
  if (!await transitionIfInState(sessionId, 'CLOSING', 'PROCESSING')) {
    const existing = await prisma.assessmentVersion.findFirst({
      where: { sessionId }, orderBy: { version: 'desc' }, select: { id: true },
    });
    if (existing) return { assessmentId: existing.id };
    // Another finalisation holds PROCESSING and has not written yet. Waiting
    // here would hold an HTTP request open on a paid call we are not making;
    // if that other run dies, the sweep recovers the session.
    throw new HttpError(409, 'This interview is already being finalised. Give it a moment and refresh.');
  }

  // Everything below runs with the session already moved to PROCESSING, and any
  // one step of it can fail: the evaluator calls a paid provider, three writes
  // follow it, and the invitation burn follows those. An unguarded throw left
  // the session in PROCESSING with no AssessmentVersion — permanently, because
  // PROCESSING is neither live (so no sweep touched it) nor finished (so no
  // reviewer saw it). The candidate stayed "in progress" for ever.
  try {
    const count = await prisma.assessmentVersion.count({ where: { sessionId } });
    const assessmentVersion = `A-${sessionId.slice(0, 6)}-v${count + 1}`;
    const result = await evaluate({
      role: profile, turns, rubricVersion: session.scorecardId, assessmentVersion, sessionId,
      techStack: roleTechStack(session.role),
      // The plan knows which competencies it had no room for. Passing that on is
      // what lets the assessment say "not asked" instead of "no evidence".
      notAssessed: plan.notAssessed,
      // Library-planned interviews only: the anchors of the entries actually asked, from the plan's snapshot.
      ...(plan.library ? { anchors: anchorsFor(plan, turns) } : {}),
    });

    // Version numbering is read and written together: the count taken before
    // evaluate() is minutes old by the time the result comes back.
    const assessment = await prisma.$transaction(async (tx) => {
      const current = await tx.assessmentVersion.count({ where: { sessionId } });
      return tx.assessmentVersion.create({
        data: {
          sessionId, scorecardId: session.scorecardId, version: current + 1,
          recommendation: result.recommendation, confidence: result.confidence,
          evidenceCoverage: result.evidenceCoverage, resultJson: JSON.stringify(result),
        },
      });
    });

    // What the library learns from this interview (library/usage.ts). Never
    // allowed to fail the finalisation: the assessment is already stored.
    if (plan.library) {
      await recordLibraryUsage({ sessionId, tenantId: session.tenantId, roleId: session.roleId, plan, turns })
        .catch((err: unknown) => {
          logger.error({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'Could not record library usage');
        });
    }

    // The candidate's feedback email (services/autoFeedback.ts) is queued the
    // moment the assessment exists and BEFORE the assessment is announced as
    // ready: a reviewer acting on that announcement at once must find a
    // letter to release, not a gap. Caught rather than thrown: the assessment
    // is already stored, and a queueing failure must not turn a finished
    // interview into a failed finalisation. The page offers "Send feedback
    // now" when no email is on record.
    await enqueueAutoFeedback({ sessionId, assessmentId: assessment.id, partial: opts.partial === true })
      .catch((err: unknown) => {
        logger.error({ sessionId, err: err instanceof Error ? err.message : String(err) }, 'Could not queue the candidate feedback email');
      });

    // Persist a transcript + report artifact.
    const report = renderReportMarkdown({ candidateName: session.candidate.fullName, roleTitle: session.role.title, assessment: result });
    await prisma.artifact.create({
      data: { tenantId: session.tenantId, sessionId, candidateId: session.candidateId, kind: 'report', filename: `${assessmentVersion}.md`, contentType: 'text/markdown', storageKey: report, sizeBytes: report.length, retentionDays: 180 },
    });
    const transcript = turns.map((t) => `[${fmt(t.startMs)}] ${t.speaker.toUpperCase()}: ${t.text}`).join('\n');
    await prisma.artifact.create({
      data: { tenantId: session.tenantId, sessionId, candidateId: session.candidateId, kind: 'transcript', filename: `${sessionId}-transcript.txt`, contentType: 'text/plain', storageKey: transcript, sizeBytes: transcript.length, retentionDays: 180 },
    });

    await prisma.interviewSession.update({ where: { id: sessionId }, data: { completedAt: new Date() } });
    // Burn the invite link. updateMany (not update) because recruiter-driven
    // sessions can finalise without an invitation ever being issued.
    await prisma.invitation.updateMany({ where: { sessionId }, data: { status: INVITATION_CONSUMED } });
    await setState(sessionId, 'PROCESSING', 'REVIEW_READY');
    await logAudit({ tenantId: session.tenantId, action: 'assessment.ready', entityType: 'AssessmentVersion', entityId: assessment.id, after: { recommendation: result.recommendation } });
    // The assessed AI interview is the Silver evidence; the candidate is at Gold.
    await notePipelineEvent({ tenantId: session.tenantId, candidateId: session.candidateId, roleId: session.roleId, event: 'interview.assessed', trigger: 'assessment.ready' });
    await emitEvent(session.tenantId, 'assessment.ready', { sessionId, assessmentId: assessment.id, recommendation: result.recommendation });
    await notifyHiringTeam({ tenantId: session.tenantId, candidateId: session.candidateId, sessionId, assessmentId: assessment.id, event: 'assessment_ready' });
    return { assessmentId: assessment.id };
  } catch (err) {
    await releaseStalledFinalisation(sessionId, err);
    // Rethrown, never swallowed: the caller decides what the candidate or the
    // recruiter is told, and a silent success here would be a finalisation that
    // produced nothing while reporting that it had.
    throw err;
  }
}

/**
 * Move a finalisation that died mid-write out of PROCESSING.
 *
 * TECHNICAL_FAILURE is the state the machine allows from PROCESSING, and it is
 * also the honest one: the interview happened, our processing of it did not.
 * From there the existing recovery routes apply (RESCHEDULE_REQUIRED, CLOSED).
 *
 * Only PROCESSING is recovered. A throw from the audit or webhook calls that
 * follow the REVIEW_READY transition leaves a perfectly good assessment behind,
 * and dragging that session into TECHNICAL_FAILURE would destroy a completed
 * result over a bookkeeping failure.
 */
async function releaseStalledFinalisation(sessionId: string, cause: unknown): Promise<void> {
  const message = cause instanceof Error ? cause.message : String(cause);
  const state = await currentState(sessionId);
  if (state !== 'PROCESSING') {
    logger.error({ sessionId, state, err: message }, 'Finalisation failed after the assessment was written');
    return;
  }
  try {
    await setState(sessionId, 'PROCESSING', 'TECHNICAL_FAILURE');
    logger.error({ sessionId, err: message }, 'Finalisation failed; session released from PROCESSING to TECHNICAL_FAILURE');
  } catch (recoveryErr) {
    // The session is still stranded, so this line is the only trace that says
    // which one and why. The sweep in services/incompleteInterviews.ts is the
    // backstop that picks it up later.
    logger.error(
      { sessionId, err: message, recoveryErr: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr) },
      'Finalisation failed and the session could not be released from PROCESSING',
    );
  }
}

async function currentState(sessionId: string): Promise<string> {
  const s = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true } });
  return s?.state ?? '';
}

export function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
