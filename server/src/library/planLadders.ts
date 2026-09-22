import type {
  Competency, CvSignal, FitScore, InterviewPlan, LibraryQuestionSnapshot, PlanBlock, PlanBlockLibrary, PlanLibrary,
} from '../domain/types.js';

/**
 * How the library's ladders become part of an interview plan. Pure: the
 * database side (library/planning.ts) fetches the ladders and the settings,
 * and this decides, block by block, which ones the plan uses.
 *
 * The planner's own output is never rewritten, only annotated: every block
 * keeps its intent, minutes and hints, so a library block that cannot be asked
 * (no model, a screened question) still has the built-in path under it.
 */

export const DEFAULT_TRIAL_PERCENT = 50;
export const CALLBACK_BLOCK_ID = '__callback__';
/** Minutes the callback turn takes from the competency blocks. */
export const CALLBACK_MINUTES = 2;
/** A competency block is never cut below this to make room for the callback. */
const MIN_BLOCK_MINUTES = 2;
/** The callback refers back to an earlier answer, so it follows at least this many competency blocks. */
export const CALLBACK_AFTER_BLOCKS = 2;

export type LibraryMode = 'off' | 'on' | 'trial';

export interface LadderPlanInput {
  readonly mode: Exclude<LibraryMode, 'off'>;
  /** Ladders by pool competency key, as `selectLadders` returns them. */
  readonly ladders: Readonly<Record<string, readonly LibraryQuestionSnapshot[]>>;
  /** Plan competency id -> pool competency key. */
  readonly competencyKeys: Readonly<Record<string, string>>;
  readonly trialPercent: number;
  /** Plan competency id -> what the CV shows. */
  readonly cvSignals: Readonly<Record<string, CvSignal>>;
  readonly rng: () => number;
  readonly meta: Omit<PlanLibrary, 'mode' | 'trialPercent' | 'unavailable'>;
}

export function isCompetencyBlock(block: PlanBlock): boolean {
  return !block.competencyId.startsWith('__');
}

/** The rung asked first: the middle one, one step up for a strong CV, one down for a thin one. */
export function startRungFor(ladderLength: number, signal: CvSignal = 'neutral'): number {
  const middle = Math.floor((ladderLength - 1) / 2);
  if (signal === 'strong') return Math.min(ladderLength - 1, middle + 1);
  if (signal === 'thin') return Math.max(0, middle - 1);
  return middle;
}

/**
 * Which of the eligible blocks the trial draws from the library, spread
 * evenly rather than clumped: at 50% the blocks alternate, from a random
 * start, so every library block sits next to a built-in one in the same
 * interview — the pairing the trial report compares.
 */
export function trialPicks(count: number, percent: number, rng: () => number): boolean[] {
  const ratio = Math.max(0, Math.min(100, percent)) / 100;
  const phase = rng();
  return Array.from({ length: count }, (_, i) => Math.floor((i + 1) * ratio + phase) > Math.floor(i * ratio + phase));
}

function libraryBlock(ladder: readonly LibraryQuestionSnapshot[], competencyKey: string, trial: boolean, cvSignal: CvSignal | undefined): PlanBlockLibrary {
  return {
    source: 'library', competencyKey, trial, ladder: [...ladder],
    startRung: startRungFor(ladder.length, cvSignal), ...(cvSignal ? { cvSignal } : {}),
  };
}

function builtinBlock(reason: PlanBlockLibrary['reason'], competencyKey: string, trial: boolean, cvSignal: CvSignal | undefined): PlanBlockLibrary {
  return { source: 'builtin', reason, competencyKey, trial, ...(cvSignal ? { cvSignal } : {}) };
}

/** Annotate each competency block with where its questions come from, and add the callback turn. */
export function applyLadders(plan: InterviewPlan, input: LadderPlanInput): InterviewPlan {
  const keyOf = (block: PlanBlock) => input.competencyKeys[block.competencyId] ?? '';
  const ladderOf = (block: PlanBlock) => input.ladders[keyOf(block)] ?? [];
  const eligible = plan.blocks.filter((b) => isCompetencyBlock(b) && keyOf(b) && ladderOf(b).length >= 2);
  const picks = input.mode === 'trial' ? trialPicks(eligible.length, input.trialPercent, input.rng) : eligible.map(() => true);
  const fromLibrary = new Map(eligible.map((b, i) => [b.competencyId, picks[i]]));

  const blocks = plan.blocks.map((block): PlanBlock => {
    if (!isCompetencyBlock(block)) return block;
    const key = keyOf(block);
    const signal = input.cvSignals[block.competencyId];
    const picked = fromLibrary.get(block.competencyId);
    if (picked === undefined) return { ...block, library: builtinBlock('no_ladder', key, false, signal) };
    const trial = input.mode === 'trial';
    return {
      ...block,
      library: picked ? libraryBlock(ladderOf(block), key, trial, signal) : builtinBlock('trial_control', key, trial, signal),
    };
  });
  // The callback comes with the library's questions: an interview the library
  // could not serve at all (or a trial that drew no block) runs as before.
  const drewOnLibrary = blocks.some((b) => b.library?.source === 'library');
  return {
    ...plan,
    blocks: drewOnLibrary ? withCallback(blocks) : blocks,
    library: { ...input.meta, mode: input.mode, ...(input.mode === 'trial' ? { trialPercent: input.trialPercent } : {}) },
  };
}

/** The plan with the library switched on for the organisation but no ladder to be had: every block built-in. */
export function unavailableLibrary(plan: InterviewPlan, mode: Exclude<LibraryMode, 'off'>, meta: LadderPlanInput['meta'], reason: NonNullable<PlanLibrary['unavailable']>, competencyKeys: Readonly<Record<string, string>>): InterviewPlan {
  const blockReason = reason === 'select_failed' ? 'select_failed' : 'no_ladder';
  const blocks = plan.blocks.map((block): PlanBlock => (isCompetencyBlock(block)
    ? { ...block, library: builtinBlock(blockReason, competencyKeys[block.competencyId] ?? '', false, undefined) }
    : block));
  return { ...plan, blocks, library: { ...meta, mode, unavailable: reason } };
}

/**
 * The callback turn: one block, after at least two competency blocks, whose
 * question the model builds live from something the candidate said earlier.
 * Its two minutes come from the largest competency blocks; an interview too
 * short to spare them simply has no callback.
 */
export function withCallback(blocks: readonly PlanBlock[]): PlanBlock[] {
  if (blocks.some((b) => b.competencyId === CALLBACK_BLOCK_ID)) return [...blocks];
  const competencyIndexes = blocks.flatMap((b, i) => (isCompetencyBlock(b) ? [i] : []));
  if (competencyIndexes.length < CALLBACK_AFTER_BLOCKS) return [...blocks];
  const minutes = blocks.map((b) => b.targetMinutes);
  let needed = CALLBACK_MINUTES;
  while (needed > 0) {
    const spare = competencyIndexes.filter((i) => minutes[i] > MIN_BLOCK_MINUTES);
    if (spare.length === 0) return [...blocks];
    const largest = spare.reduce((a, b) => (minutes[b] > minutes[a] ? b : a));
    minutes[largest] -= 1;
    needed -= 1;
  }
  const resized = blocks.map((b, i) => (minutes[i] === b.targetMinutes ? b : { ...b, targetMinutes: minutes[i] }));
  const after = competencyIndexes[CALLBACK_AFTER_BLOCKS - 1];
  const callback: PlanBlock = {
    competencyId: CALLBACK_BLOCK_ID,
    competencyName: 'Callback',
    intent: 'Refer back to something specific the candidate said in an earlier answer and ask one question about it.',
    targetMinutes: CALLBACK_MINUTES,
    followupHints: ['What happened next, or what would they do differently now?'],
    prohibited: blocks[after].prohibited,
  };
  return [...resized.slice(0, after + 1), callback, ...resized.slice(after + 1)];
}

// --- CV signals -------------------------------------------------------------

const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'from', 'into', 'management', 'skills']);

function keywordsOf(name: string): string[] {
  const words = name.toLowerCase().split(/[\s/&,()-]+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
  return [name.toLowerCase(), ...words];
}

/**
 * What the stored fit score says about each competency: 'thin' when the CV
 * never mentions it (the fit scorer listed it missing), 'strong' when two or
 * more of the CV lines it kept as evidence name it, 'neutral' otherwise. The
 * same signals the planner already uses for the resume-validation block; they
 * pitch the ladder and never touch a score.
 */
export function cvSignalsFor(fit: FitScore | undefined, competencies: readonly Pick<Competency, 'id' | 'name'>[]): Record<string, CvSignal> {
  if (!fit) return {};
  const missing = new Set(fit.missing.map((m) => m.toLowerCase()));
  const spans = fit.components.flatMap((c) => c.evidence).map((e) => e.toLowerCase());
  const signals: Record<string, CvSignal> = {};
  for (const c of competencies) {
    if (missing.has(c.name.toLowerCase())) {
      signals[c.id] = 'thin';
      continue;
    }
    const keys = keywordsOf(c.name);
    const hits = new Set(spans.filter((s) => keys.some((k) => s.includes(k)))).size;
    signals[c.id] = hits >= 2 ? 'strong' : 'neutral';
  }
  return signals;
}

/**
 * The plan as the hiring team's screens receive it: where each block's
 * questions come from, but not the library's questions or anchors. Those are
 * shared across organisations and are the evaluator's; showing them before the
 * interview would let anyone who reads the plan pass them on. A plan without
 * the library is returned as it is.
 */
export function withoutLadders<T extends Partial<InterviewPlan>>(plan: T): T {
  if (!plan.library || !Array.isArray(plan.blocks)) return plan;
  return {
    ...plan,
    blocks: plan.blocks.map((block) => {
      if (!block.library) return block;
      const { ladder: _ladder, startRung: _start, ...rest } = block.library;
      return { ...block, library: rest };
    }),
  };
}
