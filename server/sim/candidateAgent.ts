/**
 * The peer AI playing the candidate.
 *
 * Shared by both lanes on purpose: the same person has to sit in front of
 * Questor and in front of the benchmark interviewer, or the comparison measures
 * the candidate rather than the interviewer.
 */
import { callPeer, extractJson, type PeerId } from './peers.js';
import type { CandidateSpec } from './candidateFactory.js';
import type { RoleSpec } from './roleFactory.js';
import type { SimTurn } from './types.js';

/** Engine-side cap on a candidate turn; stay clear of it. */
const MAX_ANSWER_CHARS = 3_900;

/** How much dialogue the candidate can see. Enough to stay coherent, not the world. */
const HISTORY_TURNS = 8;

function renderHistory(history: SimTurn[]): string {
  if (!history.length) return '(the interview has just started)';
  return history
    .slice(-HISTORY_TURNS)
    .map((t) => `${t.speaker === 'interviewer' ? 'INTERVIEWER' : 'YOU'}: ${t.text}`)
    .join('\n');
}

export async function answerAsCandidate(opts: {
  peer: PeerId;
  candidate: CandidateSpec;
  role: RoleSpec;
  history: SimTurn[];
  question: string;
  timeoutMs?: number;
}): Promise<string> {
  const { peer, candidate, role, history, question } = opts;

  const prompt = [
    candidate.personaBrief,
    '',
    `The role you applied for: ${role.title} at ${role.organisation}.`,
    '',
    'Your CV, which the interviewer has read:',
    candidate.resumeText.slice(0, 2500),
    '',
    'The conversation so far:',
    renderHistory(history),
    '',
    `The interviewer has just said: "${question}"`,
    '',
    'Answer as this candidate would, out loud, in the first person. Stay in character.',
    'Do not narrate, do not use stage directions, do not describe what you are doing — just say the words.',
    'Never ask to end the interview and never mention that you are an AI.',
    '',
    'Reply with the spoken answer only: no preamble, no quotation marks around it, no JSON, no formatting.',
  ].join('\n');

  const raw = await callPeer(peer, prompt, { timeoutMs: opts.timeoutMs });
  return cleanAnswer(raw, candidate.fullName);
}

/**
 * Take the peer's reply as spoken words.
 *
 * Plain text rather than JSON, because the answer IS a single string — wrapping
 * it bought nothing and cost interviews: a peer that happily returns JSON for a
 * short reply drifts into prose on a long one, and a 400-word answer about
 * debugging a pipeline was rejected for having no braces in it. The JSON form is
 * still accepted if it turns up, since some peers volunteer it.
 */
export function cleanAnswer(raw: string, who: string): string {
  const wrapped = extractJson<{ answer?: unknown }>(raw);
  const fromJson = wrapped && typeof wrapped.answer === 'string' ? wrapped.answer : null;

  let text = (fromJson ?? raw)
    // Fenced blocks around the whole reply, occasionally emitted unasked.
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  // Stage directions a model adds when it forgets it is speaking, not writing.
  text = text.replace(/^\*[^*]{0,80}\*\s*/, '').trim();
  // A reply quoted as a whole, which would be read out with the quotes attached.
  if (/^["“][\s\S]+["”]$/.test(text)) text = text.slice(1, -1).trim();

  if (text.length < 2) throw new Error(`answerAsCandidate(${who}): peer returned nothing usable`);
  return text.slice(0, MAX_ANSWER_CHARS);
}
