import type { LlmProvider } from '../../src/providers/llm/types.js';
import type { SeedPool } from '../../src/library/seedExport.js';
import type { StandardRecord } from '../../src/library/seedFormat.js';
import type { PoolProgress, RunState } from './checkpoint.js';
import type { Lane } from './lanes.js';
import { PoolStageError, runPool, standardKeyOf } from './pipeline.js';
import type { LaneScheduler } from './scheduler.js';

/**
 * The seed run: pools in file order, `concurrency` at a time, each through
 * the pipeline with a rotating generator / critic / tie-break assignment.
 * When fewer than two lanes can run it sleeps until the earliest lane comes
 * back (bounded by `maxWaitMs`, after which it stops and a later run resumes).
 * State is saved after every pool.
 */

export interface SeedRunOptions {
  readonly perPool: number;
  readonly concurrency: number;
  readonly tiebreak: boolean;
  readonly maxAttempts: number;
  readonly maxWaitMs: number;
  /** Stop starting pools once this many lane calls have been made in total. */
  readonly maxCalls?: number;
}

export interface SeedRunDeps {
  readonly scheduler: LaneScheduler;
  readonly provider: (lane: Lane) => LlmProvider;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (event: Record<string, unknown>) => void;
  readonly save: (state: RunState) => void;
  readonly stopped: () => boolean;
}

export type RunExit = 'complete' | 'stopped' | 'lanes_unavailable' | 'max_calls';

function totalCalls(scheduler: LaneScheduler): number {
  return Object.values(scheduler.snapshot()).reduce((sum, s) => sum + (s?.calls ?? 0), 0);
}

export async function runSeed(pools: readonly SeedPool[], initial: RunState, opts: SeedRunOptions, deps: SeedRunDeps): Promise<{ readonly state: RunState; readonly exit: RunExit }> {
  let state = initial;
  let exit: RunExit = 'complete';
  const inFlight = new Set<string>();
  const standardsInFlight = new Set<string>();

  const update = (key: string, progress: PoolProgress, standard: StandardRecord | null): void => {
    const standards = standard && !state.standards[standardKeyOf(standard)] ? { ...state.standards, [standardKeyOf(standard)]: standard } : state.standards;
    state = { ...state, updatedAt: deps.now().toISOString(), pools: { ...state.pools, [key]: progress }, standards, lanes: deps.scheduler.snapshot() };
    deps.save(state);
  };

  const nextPool = (): { readonly pool: SeedPool; readonly index: number } | null => {
    for (const [index, pool] of pools.entries()) {
      if (state.pools[pool.key]?.status !== 'pending' || inFlight.has(pool.key)) continue;
      // Two pools needing the same new family standard wait for one another, so the family gets one standard.
      const needsStandard = !pool.standard && !state.standards[standardKeyOf(pool)];
      if (needsStandard && standardsInFlight.has(standardKeyOf(pool))) continue;
      return { pool, index };
    }
    return null;
  };

  const worker = async (): Promise<void> => {
    while (!deps.stopped()) {
      if (opts.maxCalls !== undefined && totalCalls(deps.scheduler) >= opts.maxCalls) {
        exit = 'max_calls';
        return;
      }
      const next = nextPool();
      if (!next) {
        if (inFlight.size === 0) return;
        await deps.sleep(1000);
        continue;
      }
      const { pool, index } = next;
      const progress = state.pools[pool.key];
      const assignment = deps.scheduler.assign(index + progress.attempts, deps.now().getTime());
      if (!assignment) {
        const wake = deps.scheduler.nextWake(deps.now().getTime());
        const wait = wake === null ? Number.POSITIVE_INFINITY : wake - deps.now().getTime();
        if (wait > opts.maxWaitMs) {
          exit = 'lanes_unavailable';
          deps.log({ event: 'stop', reason: 'lanes_unavailable', until: wake === null ? null : new Date(wake).toISOString() });
          return;
        }
        deps.log({ event: 'waiting', until: new Date(wake ?? 0).toISOString() });
        await deps.sleep(Math.max(1000, wait));
        continue;
      }
      inFlight.add(pool.key);
      const needsStandard = !pool.standard && !state.standards[standardKeyOf(pool)];
      if (needsStandard) standardsInFlight.add(standardKeyOf(pool));
      deps.log({ event: 'pool_start', pool: pool.key, attempt: progress.attempts + 1, ...assignment });
      try {
        const result = await runPool(pool, assignment, {
          scheduler: deps.scheduler, provider: deps.provider, runId: state.runId, now: deps.now, perPool: opts.perPool, tiebreak: opts.tiebreak, log: deps.log,
        }, {
          knownStandards: new Map(Object.entries(state.standards)),
          alreadyAccepted: progress.accepted.map((q) => q.questionText),
        });
        update(pool.key, {
          status: 'done', attempts: progress.attempts + 1, accepted: [...progress.accepted, ...result.accepted], rejected: [...progress.rejected, ...result.rejected],
          errors: progress.errors, assignment, finishedAt: deps.now().toISOString(),
        }, result.standard);
        deps.log({ event: 'pool_done', pool: pool.key, accepted: result.accepted.length, rejected: result.rejected.length, standardCreated: result.standard !== null });
      } catch (err) {
        if (!(err instanceof PoolStageError)) throw err;
        const attempts = err.laneLimited ? progress.attempts : progress.attempts + 1;
        const status = attempts >= opts.maxAttempts ? 'failed' : 'pending';
        update(pool.key, { ...progress, status, attempts, errors: [...progress.errors, err.reason] }, null);
        deps.log({ event: 'pool_error', pool: pool.key, reason: err.reason, attempts, status });
      } finally {
        inFlight.delete(pool.key);
        standardsInFlight.delete(standardKeyOf(pool));
      }
    }
    exit = 'stopped';
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, () => worker()));
  if (deps.stopped()) exit = 'stopped';
  return { state, exit };
}
