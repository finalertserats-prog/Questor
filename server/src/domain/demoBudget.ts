/**
 * What a demo interview may spend on a real model, and where the line is.
 *
 * THE LINE, EXACTLY (owner, 2026-09-24).
 *
 * A demo session is heuristic-only everywhere. `runAsDemo` puts every request
 * a demo visitor makes into a context where `generateJson` returns null, and
 * every demo interview is recognised by its tenant, so the candidate side gets
 * the same answer without a session. That default does not change: role
 * extraction, catalogue work, grading, the report writer, the candidate's own
 * closing question — none of them ever spend, however the demo is taken.
 *
 * ONE exception is carved out of it, and it is narrow in four ways at once:
 *
 *   - by MODE: only a 'candidate' run, where a person is actually answering.
 *     Observer mode is a written script and never calls a model at all.
 *   - by FUNCTION: only the interviewer reacting to what the visitor just said
 *     and the intent read that keeps "stop" from being treated as an answer.
 *     The scaffolding — opening, transitions, close, sign-off, scoring, the
 *     written report — stays on the built-in writer.
 *   - by RUN: a fixed number of reactive turns per sitting.
 *   - by DAY: a fixed number across every demo, so one busy afternoon cannot
 *     spend the month.
 *
 * Past any of those, `generateJson` returns null and the built-in writer takes
 * the turn. The visitor is NOT told. There is nothing for them to do about it,
 * the interview carries on, and an interviewer that announced its own funding
 * would be the least convincing thing in the demo.
 */

/**
 * The model calls a demo interview may make, by the `fn` name the provider
 * layer logs them under.
 *
 * `live_interviewer` is the reactive turn: it is handed the candidate's own
 * words and told to interrogate what they actually said. `candidate_intent`
 * is the read that distinguishes "I'd like to stop" from an answer, and is
 * included because getting that wrong in front of a prospect — carrying on
 * after someone has asked to stop — is the worst thing the demo could do.
 *
 * Everything absent from this set is deliberate. `candidate_question`
 * (answering the visitor's question at the close), `competency_grader` and
 * `report_writer` are all built-in in a demo: they are not the part a prospect
 * is judging the conversation by, and the grader runs once per competency.
 */
export const DEMO_SPENDABLE_FUNCTIONS: ReadonlySet<string> = new Set(['live_interviewer', 'candidate_intent']);

export function isSpendableFunction(fn: string): boolean {
  return DEMO_SPENDABLE_FUNCTIONS.has(fn);
}

/**
 * Reactive turns one sitting may buy.
 *
 * Fifteen minutes of conversation is roughly ten to twelve candidate answers.
 * Twelve covers a whole sitting; a thirteenth means something is looping, and
 * a loop that also spends is the failure worth bounding.
 */
export const DEMO_SPEND_PER_RUN = 12;

/**
 * Reactive turns all demos together may buy in a day.
 *
 * A day, not a month: a ceiling measured in months hides the afternoon that
 * exhausted it until the month is gone.
 */
export const DEMO_SPEND_PER_DAY = 240;

/** The day a spend belongs to, in UTC, as the counter's key. */
export function spendDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface DemoSpendState {
  readonly mode: string;
  readonly ended: boolean;
  readonly runSpent: number;
  readonly daySpent: number;
}

export type DemoSpendVerdict = 'allow' | 'not_reactive' | 'not_candidate_mode' | 'run_exhausted' | 'day_exhausted' | 'ended';

/**
 * Whether this call may reach a paid model. Pure: the counters are read and
 * written by the service, so the rule itself can be reasoned about alone.
 */
export function spendVerdict(fn: string, state: DemoSpendState): DemoSpendVerdict {
  if (!isSpendableFunction(fn)) return 'not_reactive';
  if (state.mode !== 'candidate') return 'not_candidate_mode';
  if (state.ended) return 'ended';
  if (state.runSpent >= DEMO_SPEND_PER_RUN) return 'run_exhausted';
  if (state.daySpent >= DEMO_SPEND_PER_DAY) return 'day_exhausted';
  return 'allow';
}

export function maySpend(fn: string, state: DemoSpendState): boolean {
  return spendVerdict(fn, state) === 'allow';
}

/**
 * Whether a refused spend is worth an operator's attention.
 *
 * A run running out is ordinary — it means a demo went the distance. A DAY
 * running out means prospects after this one are getting the built-in writer,
 * which is exactly the thing the owner does not want happening unnoticed.
 */
export function refusalIsNotable(verdict: DemoSpendVerdict): boolean {
  return verdict === 'day_exhausted';
}
