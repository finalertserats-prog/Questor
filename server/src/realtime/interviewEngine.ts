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
import { logger } from '../logger.js';

const AVG_MS_PER_TURN = 40_000; // virtual pacing when real timestamps are absent

export interface AgentTurnOut {
  turnId: string;
  index: number;
  text: string;
  competencyId: string;
  kind: string;
  state: string;
  done: boolean;
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
  const persona = parseJson<Persona>(session.personaJson, { name: 'Alex', tone: 'warm' });
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

async function appendTurn(sessionId: string, turn: Omit<TurnRecord, 'id'>): Promise<TurnRecord> {
  const rec = await prisma.turn.create({
    data: {
      id: nanoid(10), sessionId, index: turn.index, speaker: turn.speaker, text: turn.text,
      startMs: turn.startMs, endMs: turn.endMs, confidence: turn.confidence, competencyId: turn.competencyId ?? '',
    },
  });
  return { id: rec.id, index: rec.index, speaker: rec.speaker as TurnRecord['speaker'], text: rec.text, startMs: rec.startMs, endMs: rec.endMs, confidence: rec.confidence, competencyId: rec.competencyId };
}

async function setState(sessionId: string, from: string, to: string) {
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
  const done = utter.kind === 'signoff' || utter.kind === 'safety';
  return {
    turnId: agentTurn.id, index: agentTurn.index, text: utter.text, competencyId: utter.competencyId,
    kind: utter.kind, state: session.state, done,
  };
}

/** Begin the assessed conversation: move to ASSESSING and emit the opening. */
export async function startInterview(sessionId: string): Promise<AgentTurnOut> {
  const { session } = await loadContext(sessionId);
  // Pre-live states (invite/accept/consent/ready-check) are governed by the
  // portal + recruiter flows. "Start" converges every valid entry point to the
  // live ASSESSING state; the opening disclosure/warmup turns are still emitted
  // by the conversation runtime so the candidate always gets them.
  if (!['ASSESSING', 'CANDIDATE_QUESTIONS'].includes(session.state)) {
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: 'ASSESSING' } });
  }
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { startedAt: new Date() } });
  await logAudit({ tenantId: session.tenantId, action: 'interview.started', entityType: 'InterviewSession', entityId: sessionId });
  await emitEvent(session.tenantId, 'interview.started', { sessionId });
  return produceAgentTurn(sessionId);
}

/** Ingest a candidate turn and return the next agent turn. */
export async function submitCandidateTurn(sessionId: string, text: string, timing?: { startMs?: number; endMs?: number; confidence?: number }): Promise<AgentTurnOut> {
  const { turns, plan } = await loadContext(sessionId);
  // Attribute this answer to whatever competency the last agent question targeted.
  const lastAgent = [...turns].reverse().find((t) => t.speaker === 'agent');
  const competencyId = lastAgent?.competencyId ?? '';
  const injection = detectInjection(text);
  if (injection.injection) {
    logger.info({ sessionId, matched: injection.matched }, 'Prompt-injection attempt ignored');
  }
  const lastEnd = turns.reduce((m, t) => Math.max(m, t.endMs), 0);
  await appendTurn(sessionId, {
    index: turns.length, speaker: 'candidate', text,
    startMs: timing?.startMs ?? lastEnd + 1000,
    endMs: timing?.endMs ?? lastEnd + 30_000,
    confidence: timing?.confidence ?? 0.9,
    competencyId,
  });
  return produceAgentTurn(sessionId);
}

/** Close the interview, run the independent evaluator and persist the assessment. */
export async function finalizeInterview(sessionId: string): Promise<{ assessmentId: string }> {
  const { session, profile, turns } = await loadContext(sessionId);
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
  await setState(sessionId, 'PROCESSING', 'REVIEW_READY');
  await logAudit({ tenantId: session.tenantId, action: 'assessment.ready', entityType: 'AssessmentVersion', entityId: assessment.id, after: { recommendation: result.recommendation } });
  await emitEvent(session.tenantId, 'assessment.ready', { sessionId, assessmentId: assessment.id, recommendation: result.recommendation });
  return { assessmentId: assessment.id };
}

async function currentState(sessionId: string): Promise<string> {
  const s = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true } });
  return s?.state ?? '';
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
