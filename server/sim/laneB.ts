/**
 * Lane B — a peer AI conducts the interview instead of Questor.
 *
 * This lane produces the benchmark: what a capable general model does with the
 * same job description, the same CV and the same person answering. Without it,
 * a judge scoring Questor alone has nothing to calibrate against and every
 * verdict is an opinion about an absolute standard nobody agreed on.
 *
 * The interviewer peer is given exactly what Questor is given — the JD and the
 * CV — and specifically NOT the candidate's band. Handing it the answer to the
 * question under test would make the benchmark unbeatable and meaningless.
 */
import { callPeer, type PeerId } from './peers.js';
import { answerAsCandidate, cleanAnswer } from './candidateAgent.js';
import type { RoleSpec } from './roleFactory.js';
import type { CandidateSpec } from './candidateFactory.js';
import type { SimTranscript, SimTurn } from './types.js';

/** Comparable to what Lane A fits into a 20-minute plan. */
const MAX_QUESTIONS = 12;

/** What the interviewer says to signal it has covered enough. */
const END_MARKER = '[END]';

const HISTORY_TURNS = 10;

function renderHistory(history: SimTurn[]): string {
  if (!history.length) return '(nothing yet — this is your opening)';
  return history
    .slice(-HISTORY_TURNS)
    .map((t) => `${t.speaker === 'interviewer' ? 'YOU' : 'CANDIDATE'}: ${t.text}`)
    .join('\n');
}

async function nextQuestion(opts: {
  peer: PeerId;
  role: RoleSpec;
  candidate: CandidateSpec;
  history: SimTurn[];
  questionsAsked: number;
  timeoutMs?: number;
}): Promise<string> {
  const { peer, role, candidate, history, questionsAsked } = opts;

  const prompt = [
    'You are conducting a first-round screening interview by voice. You are a skilled, fair human interviewer.',
    '',
    `Role: ${role.title} at ${role.organisation}`,
    `Job description:\n${role.jdText.slice(0, 2000)}`,
    '',
    `The candidate's CV:\n${candidate.resumeText.slice(0, 2000)}`,
    '',
    'Conversation so far:',
    renderHistory(history),
    '',
    `You have asked ${questionsAsked} of at most ${MAX_QUESTIONS} questions.`,
    '',
    'Ask your next question. Rules:',
    '- exactly ONE question, 1-3 sentences, in natural spoken English',
    '- pitch it at the level this candidate actually operates at, judging from their CV',
    '- engage with what they just said rather than moving to a fresh topic when there is something worth pursuing',
    '- vary the form of your questions; do not open the same way twice running',
    '- never ask about age, religion, caste, marital status, nationality, health, appearance or accent',
    `- if you have covered enough, or you have reached ${MAX_QUESTIONS} questions, reply with exactly ${END_MARKER}`,
    '',
    'Reply with the question only: no preamble, no numbering, no quotation marks.',
  ].join('\n');

  const raw = await callPeer(peer, prompt, { timeoutMs: opts.timeoutMs });
  return cleanAnswer(raw, `interviewer:${peer}`);
}

export async function runLaneB(opts: {
  role: RoleSpec;
  candidate: CandidateSpec;
  interviewerPeer: PeerId;
  candidatePeer: PeerId;
  peerTimeoutMs?: number;
}): Promise<SimTranscript> {
  const startedAt = Date.now();
  const turns: SimTurn[] = [];
  const base: Omit<SimTranscript, 'endedEarly' | 'durationMs'> = {
    lane: 'peer',
    interviewer: opts.interviewerPeer,
    candidatePeer: opts.candidatePeer,
    role: opts.role,
    candidate: opts.candidate,
    turns,
  };

  try {
    for (let asked = 0; asked < MAX_QUESTIONS; asked++) {
      const question = await nextQuestion({
        peer: opts.interviewerPeer,
        role: opts.role,
        candidate: opts.candidate,
        history: turns,
        questionsAsked: asked,
        timeoutMs: opts.peerTimeoutMs,
      });
      if (question.includes(END_MARKER)) break;

      turns.push({ speaker: 'interviewer', text: question });

      const answer = await answerAsCandidate({
        peer: opts.candidatePeer,
        candidate: opts.candidate,
        role: opts.role,
        history: turns,
        question,
        timeoutMs: opts.peerTimeoutMs,
      });
      turns.push({ speaker: 'candidate', text: answer });
    }

    return {
      ...base,
      // No sign-off machinery here — the lane ends when the interviewer says so
      // or the cap is hit. Neither is "early" in the sense Lane A means it.
      endedEarly: turns.length === 0,
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
