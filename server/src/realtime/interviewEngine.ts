import { nanoid } from 'nanoid';
import { prisma, parseJson } from '../db.js';
import type { InterviewPlan, RoleSuccessProfile, TurnRecord } from '../domain/types.js';
import { assertTransition } from '../domain/stateMachine.js';
import { directorDecide } from '../engines/interviewDirector.js';
import { nextUtterance, type Persona } from '../engines/conversationRuntime.js';
import { detectInjection } from '../engines/policyEngine.js';
import { evaluate } from '../engines/evaluator.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import { emitEvent } from '../services/webhooks.js';
import { logAudit } from '../services/audit.js';
import { HttpError } from '../middleware/index.js';
import { logger } from '../logger.js';

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
  const plan = parseJson<InterviewPlan>(session.plan.planJson, {} as InterviewPlan);
  const profile = parseJson<RoleSuccessProfile>(session.scorecard.profileJson, {} as RoleSuccessProfile);
  const persona = parseJson<Persona>(session.personaJson, { name: 'Schranders', tone: 'warm' });
  const turns: TurnRecord[] = session.turns.map((t) => ({
    id: t.id, index: t.index, speaker: t.speaker as TurnRecord['speaker'], text: t.text,
    startMs: t.startMs, endMs: t.endMs, confidence: t.confidence, competencyId: t.competencyId,
  }));
  return { session, plan, profile, persona, turns };
}

function elapsedMinutes(turns: TurnRecord[]): number {
  const maxEnd = turns.reduce((m, t) => Math.max(m, t.endMs), 0);
  if (maxEnd > 0) return maxEnd / 60000;
  return (turns.length * AVG_MS_PER_TURN) / 60000;
}

async function appendTurn(sessionId: string, turn: Omit<TurnRecord, 'id'>, meta?: Record<string, unknown>): Promise<TurnRecord> {
  const rec = await prisma.turn.create({
    data: {
      id: nanoid(10), sessionId, index: turn.index, speaker: turn.speaker, text: turn.text,
      startMs: turn.startMs, endMs: turn.endMs, confidence: turn.confidence, competencyId: turn.competencyId ?? '',
      ...(meta ? { metaJson: JSON.stringify(meta) } : {}),
    },
  });
  return { id: rec.id, index: rec.index, speaker: rec.speaker as TurnRecord['speaker'], text: rec.text, startMs: rec.startMs, endMs: rec.endMs, confidence: rec.confidence, competencyId: rec.competencyId };
}

export async function setState(sessionId: string, from: string, to: string) {
  assertTransition(from, to);
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: to } });
}

/** Produce and persist the next agent turn given the current transcript. */
async function produceAgentTurn(sessionId: string): Promise<AgentTurnOut> {
  const { session, plan, profile, persona, turns } = await loadContext(sessionId);
  const signal = directorDecide({ plan, turns, elapsedMinutes: elapsedMinutes(turns) });
  const disclosure = parseJson<any>(session.consentJson, {}).disclosureText ?? '';
  const utter = await nextUtterance({ plan, signal, turns, role: profile, persona, disclosureText: disclosure, sessionId });

  const lastEnd = turns.reduce((m, t) => Math.max(m, t.endMs), 0);
  const agentTurn = await appendTurn(sessionId, {
    index: turns.length, speaker: 'agent', text: utter.text,
    startMs: lastEnd, endMs: lastEnd + 12_000, confidence: 1, competencyId: utter.competencyId,
  });

  // 'close' invites the candidate's own questions and must stay open for their
  // reply; the session ends on the sign-off that follows it.
  // 'withdrawn' ends the session like a sign-off: the candidate asked to stop,
  // so the next thing that happens must not be another question.
  const done = utter.kind === 'signoff' || utter.kind === 'safety' || utter.kind === 'withdrawn';
  // Safety stops and withdrawals both end the conversation because the person
  // asked to leave — neither is a completed interview, and neither may be
  // scored.
  const withdrawn = utter.kind === 'withdrawn' || utter.kind === 'safety';
  return {
    turnId: agentTurn.id, index: agentTurn.index, text: utter.text, competencyId: utter.competencyId,
    kind: utter.kind, state: session.state, done, withdrawn,
  };
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
export async function withdrawInterview(sessionId: string, reason: 'candidate_withdrew' | 'safety_stop'): Promise<void> {
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { tenantId: true, state: true } });
  if (!session) return;
  if (['CANDIDATE_WITHDREW', 'POLICY_STOP', 'CLOSED'].includes(session.state)) return; // already closed

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

/** Begin the assessed conversation: move to ASSESSING and emit the opening. */
export async function startInterview(sessionId: string): Promise<AgentTurnOut> {
  const { session } = await loadContext(sessionId);
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
    if (!STARTABLE_STATES.includes(session.state)) {
      // Candidate-facing. An internal state name reads as a crash to the person
      // it is shown to, and MANUAL_HANDOFF in particular means "a human is
      // coming" — which is reassuring information delivered as an error.
      throw new HttpError(409, session.state === 'MANUAL_HANDOFF'
        ? 'You asked to be interviewed by a person instead. Our team has your request and will be in touch — there is nothing more to do here. If you would rather continue with the AI interview after all, reply to your invitation email and we will reopen it.'
        : 'This interview is not open right now. If you think that is wrong, reply to your invitation email and we will look into it.');
    }
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: 'ASSESSING' } });
  }
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { startedAt: new Date() } });
  await logAudit({ tenantId: session.tenantId, action: 'interview.started', entityType: 'InterviewSession', entityId: sessionId });
  await emitEvent(session.tenantId, 'interview.started', { sessionId });
  return produceAgentTurn(sessionId);
}

/** Ingest a candidate turn and return the next agent turn. */
export async function submitCandidateTurn(sessionId: string, text: string, timing?: { startMs?: number; endMs?: number; confidence?: number }): Promise<AgentTurnOut> {
  const { session, turns } = await loadContext(sessionId);
  // All three guards run before any LLM call so an abusive caller never reaches
  // a billable path.
  if (text.length > MAX_ANSWER_CHARS) {
    logger.warn({ sessionId, chars: text.length }, 'Oversized candidate answer refused');
    throw new HttpError(400, `That answer is too long (limit ${MAX_ANSWER_CHARS} characters).`);
  }
  if (!LIVE_STATES.includes(session.state)) {
    throw new HttpError(409, 'This interview is no longer accepting answers.');
  }
  if (turns.length >= MAX_TURNS_PER_SESSION) {
    logger.warn({ sessionId, turns: turns.length }, 'Interview turn cap reached; refusing further turns');
    throw new HttpError(429, 'This interview has reached its maximum length. Our team will follow up with you.');
  }

  // Attribute this answer to whatever competency the last agent question targeted.
  const lastAgent = [...turns].reverse().find((t) => t.speaker === 'agent');
  const competencyId = lastAgent?.competencyId ?? '';
  const injection = detectInjection(text);
  if (injection.injection) {
    // The interviewer never obeys the injected text, but a human reads the
    // report — the attempt itself is signal about the candidate and must
    // survive on the turn record rather than living only in the server log.
    logger.warn({ sessionId, index: turns.length, matched: injection.matched, textLength: text.length }, 'Prompt-injection attempt flagged on candidate turn');
  }
  const lastEnd = turns.reduce((m, t) => Math.max(m, t.endMs), 0);
  await appendTurn(sessionId, {
    index: turns.length, speaker: 'candidate', text,
    startMs: timing?.startMs ?? lastEnd + 1000,
    endMs: timing?.endMs ?? lastEnd + 30_000,
    confidence: timing?.confidence ?? 0.9,
    competencyId,
  }, injection.injection ? { flags: ['prompt_injection'], injectionMatched: injection.matched, flaggedAt: new Date().toISOString() } : undefined);
  return produceAgentTurn(sessionId);
}

/** Close the interview, run the independent evaluator and persist the assessment. */
export async function finalizeInterview(sessionId: string): Promise<{ assessmentId: string }> {
  const { session, profile, turns } = await loadContext(sessionId);
  if (!FINALIZABLE_STATES.includes(session.state)) {
    const existing = await prisma.assessmentVersion.findFirst({
      where: { sessionId }, orderBy: { version: 'desc' }, select: { id: true },
    });
    // Idempotent: hand back the assessment that already exists rather than
    // minting another version and another set of artifacts.
    if (existing) return { assessmentId: existing.id };
    throw new HttpError(409, `This interview cannot be finalised from its current state (${session.state}).`);
  }
  // Transition CLOSING -> PROCESSING.
  if (session.state === 'ASSESSING' || session.state === 'CANDIDATE_QUESTIONS') {
    if (session.state === 'ASSESSING') { await setState(sessionId, 'ASSESSING', 'CANDIDATE_QUESTIONS'); }
    await setState(sessionId, 'CANDIDATE_QUESTIONS', 'CLOSING');
  }
  if ((await currentState(sessionId)) === 'CLOSING') await setState(sessionId, 'CLOSING', 'PROCESSING');

  const count = await prisma.assessmentVersion.count({ where: { sessionId } });
  const assessmentVersion = `A-${sessionId.slice(0, 6)}-v${count + 1}`;
  const result = await evaluate({
    role: profile, turns, rubricVersion: session.scorecardId, assessmentVersion, sessionId,
  });

  const assessment = await prisma.assessmentVersion.create({
    data: {
      sessionId, scorecardId: session.scorecardId, version: count + 1,
      recommendation: result.recommendation, confidence: result.confidence,
      evidenceCoverage: result.evidenceCoverage, resultJson: JSON.stringify(result),
    },
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
  await emitEvent(session.tenantId, 'assessment.ready', { sessionId, assessmentId: assessment.id, recommendation: result.recommendation });
  return { assessmentId: assessment.id };
}

async function currentState(sessionId: string): Promise<string> {
  const s = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true } });
  return s?.state ?? '';
}

export function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
