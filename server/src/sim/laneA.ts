/**
 * Lane A — Questor's real engine interviews a peer AI playing the candidate.
 *
 * This is the lane that improves the product. It runs the actual director,
 * planner, conversation runtime and evaluator against the actual database, so
 * whatever it produces is what a real candidate would have got. Nothing here
 * simulates the interviewer; the only synthetic party is the person answering.
 */
import { prisma } from '../db.js';
import {
  startInterview,
  submitCandidateTurn,
  finalizeInterview,
  withdrawInterview,
} from '../realtime/interviewEngine.js';
import { createSimSession } from './session.js';
import { answerAsCandidate } from './candidateAgent.js';
import type { PeerId } from './peers.js';
import type { RoleSpec } from './roleFactory.js';
import type { CandidateSpec } from './candidateFactory.js';
import type { SimTranscript, SimTurn } from './types.js';

/** Hard stop. A 20-minute interview lands near 20 turns; 60 means something broke. */
const MAX_TURNS = 60;

/** Virtual pacing, so the director's time budget advances as it would live. */
const MS_PER_TURN = 45_000;

export async function runLaneA(opts: {
  role: RoleSpec;
  candidate: CandidateSpec;
  candidatePeer: PeerId;
  durationMinutes?: number;
  peerTimeoutMs?: number;
}): Promise<SimTranscript> {
  const startedAt = Date.now();
  const turns: SimTurn[] = [];
  const base: Omit<SimTranscript, 'endedEarly' | 'durationMs'> = {
    lane: 'questor',
    interviewer: 'questor',
    candidatePeer: opts.candidatePeer,
    role: opts.role,
    candidate: opts.candidate,
    turns,
  };

  try {
    const { sessionId } = await createSimSession({
      role: opts.role,
      candidate: opts.candidate,
      durationMinutes: opts.durationMinutes,
    });

    let agent = await startInterview(sessionId);
    turns.push({ speaker: 'interviewer', text: agent.text, kind: agent.kind });

    let n = 0;
    while (!agent.done && n < MAX_TURNS) {
      n++;
      const answer = await answerAsCandidate({
        peer: opts.candidatePeer,
        candidate: opts.candidate,
        role: opts.role,
        history: turns,
        question: agent.text,
        timeoutMs: opts.peerTimeoutMs,
      });
      turns.push({ speaker: 'candidate', text: answer });

      agent = await submitCandidateTurn(sessionId, answer, {
        startMs: n * MS_PER_TURN,
        endMs: n * MS_PER_TURN + 30_000,
        confidence: 0.92,
      });
      turns.push({ speaker: 'interviewer', text: agent.text, kind: agent.kind });
    }

    // A withdrawal or safety stop must NOT be scored — the engine tells the
    // candidate nothing they said will count against them, and finalising anyway
    // would put a score behind that promise.
    if (agent.withdrawn) {
      await withdrawInterview(sessionId, agent.kind === 'safety' ? 'safety_stop' : 'candidate_withdrew');
      return { ...base, endedEarly: true, durationMs: Date.now() - startedAt };
    }

    const { assessmentId } = await finalizeInterview(sessionId);
    const row = await prisma.assessmentVersion.findUnique({
      where: { id: assessmentId },
      select: { recommendation: true, confidence: true, evidenceCoverage: true },
    });

    return {
      ...base,
      assessment: row ?? undefined,
      // Ran out of turns rather than reaching a sign-off: the transcript is real
      // but incomplete, and the judge needs to know that before scoring it.
      endedEarly: n >= MAX_TURNS,
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      ...base,
      endedEarly: true,
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - startedAt,
    };
  }
}
