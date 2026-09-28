import { z } from 'zod';
import type { LocalVariant } from '../providers/llm/index.js';
import { screenGlue } from './glueGuard.js';

/**
 * What the local fallback model is asked for on a spoken turn, and what its
 * reply must pass before it is said.
 *
 * The substance never comes from the local model. The question is one the plan
 * already holds: the library ladder's rung, or the built-in writer's own
 * question. The local model writes the acknowledgement around it and, where the
 * plan offers more than one, picks the probe that fits what the candidate said.
 * It keeps the primary's system prompt, so the interviewer's persona and voice
 * do not change at the switch; these instructions are appended to it.
 */

/** An acknowledgement is one short sentence. */
const ACK_MAX_WORDS = 30;
const ACK_MAX_CHARS = 240;
/** A reply to the candidate's own question: two short spoken sentences. */
const ANSWER_MAX_WORDS = 50;
const ANSWER_MAX_CHARS = 400;

const glueSchema = z.object({
  acknowledgement: z.string().max(600).optional(),
  probe: z.number().int().optional(),
});

export interface PlannedUtterance {
  acknowledgement?: string;
  question: string;
}

/**
 * The local variant of the interviewer's turn. `planned` holds one to three
 * questions from the plan, the first being what the built-in writer would ask.
 * `groundedIn` is what the acknowledgement may draw on: the candidate's words.
 */
export function interviewerGlueVariant(planned: readonly string[], groundedIn: readonly string[]): LocalVariant<PlannedUtterance> {
  const options = planned.map((q, i) => `${i}. ${q}`).join('\n');
  const choosing = planned.length > 1;
  return {
    systemSuffix:
      'FALLBACK MODE — this overrides the output format above. The next question is already chosen from the interview plan; ' +
      'do NOT write a question of your own and do not ask anything. Write only the "acknowledgement": one short spoken sentence ' +
      `(at most ${ACK_MAX_WORDS - 5} words) reflecting the substance of the candidate's last answer, in your usual voice. ` +
      'Use only what the candidate actually said: no names, numbers or details they did not give, no praise, no question marks. ' +
      'Leave it empty if their last turn was not an answer. ' +
      (choosing
        ? 'Also set "probe" to the number of the planned question below that best follows what the candidate said. Output JSON exactly: {"acknowledgement": "...", "probe": 0}.'
        : 'Output JSON exactly: {"acknowledgement": "..."}.'),
    userSuffix: `Planned next question${choosing ? 's (choose one)' : ' (asked after your acknowledgement)'}:\n${options}`,
    validate: (raw: unknown): PlannedUtterance => {
      const parsed = glueSchema.parse(raw);
      const ack = parsed.acknowledgement?.trim() ?? '';
      const verdict = screenGlue(ack, { maxWords: ACK_MAX_WORDS, maxChars: ACK_MAX_CHARS, maxQuestions: 0, groundedIn });
      if (!verdict.ok) throw new Error(`local acknowledgement rejected: ${verdict.reason}`);
      const probe = parsed.probe !== undefined && parsed.probe >= 0 && parsed.probe < planned.length ? parsed.probe : 0;
      return { question: planned[probe], ...(ack ? { acknowledgement: ack } : {}) };
    },
  };
}

/**
 * The local variant of answering the candidate's own question. `groundedIn` is
 * the role facts the prompt carries: every name and figure must come from there.
 */
export function candidateAnswerVariant(groundedIn: readonly string[]): LocalVariant<{ answer: string }> {
  return {
    systemSuffix:
      `FALLBACK MODE: answer in at most two short spoken sentences (${ANSWER_MAX_WORDS - 10} words). Use only the role facts given; ` +
      'if they do not answer it, say you do not have that detail and the hiring team will cover it. No names or numbers that are not in the facts. No questions.',
    validate: (raw: unknown) => {
      const parsed = z.object({ answer: z.string().min(3).max(600) }).parse(raw);
      const answer = parsed.answer.trim();
      const verdict = screenGlue(answer, { maxWords: ANSWER_MAX_WORDS, maxChars: ANSWER_MAX_CHARS, maxQuestions: 0, groundedIn });
      if (!verdict.ok) throw new Error(`local answer rejected: ${verdict.reason}`);
      return { answer };
    },
  };
}
