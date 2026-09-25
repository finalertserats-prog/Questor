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
 *   - by FUNCTION: only the interviewer reacting to what the visitor just
 *     said. The scaffolding — opening, transitions, close, sign-off — and all
 *     of the scoring and the written report stay on the built-in writer.
 *   - by RUN: a fixed number of reactive turns per sitting, claimed as a whole
 *     when the sitting starts and spent one atomic increment at a time.
 *   - by DAY: a fixed number across every demo, so one busy afternoon cannot
 *     spend the month. Reaching it does not degrade a running interview — it
 *     withdraws the candidate-side offer before anyone else starts one.
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
 * EXACTLY ONE. `live_interviewer` is the reactive turn: it is handed the
 * candidate's own words and told to interrogate what they actually said. That
 * is the whole of what the owner authorised — "the interviewer reacting to
 * what the visitor actually says" — and this set is the literal reading of it.
 *
 * `candidate_intent` was in here, on the argument that mistaking "I'd like to
 * stop" for an answer is the worst thing a demo could do. Codex was right that
 * this is an argument for widening the exception, not a thing the owner
 * granted, and a budget exception that grows by good argument is how these
 * stop being exceptions. The intent read keeps its deterministic pattern
 * check, which is what kept "stop" working before any model existed.
 *
 * Everything else absent is equally deliberate: `candidate_question`
 * (answering the visitor at the close), `competency_grader` and
 * `report_writer` are all built-in in a demo.
 */
export const DEMO_SPENDABLE_FUNCTIONS: ReadonlySet<string> = new Set(['live_interviewer']);

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
  /** What this sitting claimed from the day's ceiling when it started. */
  readonly reserved: number;
}

export type DemoSpendVerdict = 'allow' | 'not_reactive' | 'not_candidate_mode' | 'run_exhausted' | 'ended';

/**
 * Whether this call may reach a paid model.
 *
 * There is no day check here any more. The day is claimed ONCE, as a whole
 * sitting's worth, when the sitting starts (services/demoInterviewRun.ts,
 * `reserveSitting`). Checking it per call was both a race — concurrent turns
 * all read the same count and all spent — and a broken promise: readiness had
 * already told this visitor their interview would be properly delivered, and a
 * promise re-checked every turn is not a promise.
 */
export function spendVerdict(fn: string, state: DemoSpendState): DemoSpendVerdict {
  if (!isSpendableFunction(fn)) return 'not_reactive';
  if (state.mode !== 'candidate') return 'not_candidate_mode';
  if (state.ended) return 'ended';
  if (state.runSpent >= state.reserved) return 'run_exhausted';
  return 'allow';
}

export function maySpend(fn: string, state: DemoSpendState): boolean {
  return spendVerdict(fn, state) === 'allow';
}

/**
 * Whether a refused spend is worth an operator's attention.
 *
 * A sitting exhausting its reservation means an interview ran longer than the
 * allowance written for it — which is worth knowing, because from that turn on
 * a prospect is reading the built-in writer. The DAY running out is no longer
 * a refusal at all: it withdraws the candidate-side offer before anyone starts
 * (services/demoReadiness.ts), which is the point.
 */
export function refusalIsNotable(verdict: DemoSpendVerdict): boolean {
  return verdict === 'run_exhausted';
}
