import type { InterviewPlan, PlanBlock, TurnRecord } from '../domain/types.js';

/**
 * The coverage guard for interviews the Q&A library planned (plan.library
 * set). A ladder gives the interviewer a real next question at every rung,
 * which makes it easy to keep going on one competency; this keeps one long
 * early answer from starving the competencies after it.
 *
 *   - At most MAX_PROBES follow-ups after a block's first question.
 *   - A block that has run past its minutes (plus a minute's grace) closes
 *     once it has an answer.
 *   - When what is left of the interview only just covers the blocks not yet
 *     started, the current block closes once it has an answer.
 *
 * Time is judged on the clock, never on how the candidate speaks: a slow or
 * paused answer spends the block's minutes like any other, and closing the
 * block is not a judgement on the answer. A plan without the library is not
 * touched, so an interview planned without it runs exactly as before.
 */

export const MAX_PROBES = 2;
export const OVERRUN_GRACE_MINUTES = 1;
/** The least time a block not yet started is worth keeping for. */
const MIN_BLOCK_MINUTES = 2;
/** Room for one more follow-up on the current block. */
const FOLLOWUP_MINUTES = 2;

/** Minutes from the first turn of the block to its last, on the recorded clock. */
export function minutesSpentIn(blockId: string, turns: readonly TurnRecord[]): number {
  const own = turns.filter((t) => t.competencyId === blockId);
  if (own.length === 0) return 0;
  const start = Math.min(...own.map((t) => t.startMs));
  const end = Math.max(...own.map((t) => t.endMs));
  return Math.max(0, end - start) / 60_000;
}

function reserveFor(plan: InterviewPlan, current: PlanBlock, coverage: Readonly<Record<string, number>>): number {
  const at = plan.blocks.indexOf(current);
  return plan.blocks.slice(at + 1).reduce((sum, b) => {
    if (b.competencyId === '__candidate_questions__') return sum + b.targetMinutes;
    if ((coverage[b.competencyId] ?? 0) > 0) return sum;
    return sum + Math.min(b.targetMinutes, MIN_BLOCK_MINUTES);
  }, 0);
}

/** The answer quota the director may use for this block, never more than it had. */
export function guardedQuota(opts: {
  readonly plan: InterviewPlan;
  readonly block: PlanBlock;
  readonly quota: number;
  readonly coverage: Readonly<Record<string, number>>;
  readonly turns: readonly TurnRecord[];
  readonly elapsedMinutes: number;
}): number {
  const { plan, block, quota, coverage } = opts;
  if (!plan.library || block.competencyId.startsWith('__')) return quota;
  const capped = Math.min(quota, 1 + MAX_PROBES);
  const answered = coverage[block.competencyId] ?? 0;
  if (answered === 0) return capped;
  const overrun = minutesSpentIn(block.competencyId, opts.turns) >= block.targetMinutes + OVERRUN_GRACE_MINUTES;
  const remaining = plan.durationMinutes - opts.elapsedMinutes;
  const tight = remaining - reserveFor(plan, block, coverage) < FOLLOWUP_MINUTES;
  return overrun || tight ? Math.min(capped, answered) : capped;
}
