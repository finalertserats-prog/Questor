import { config } from '../config.js';
import { logger } from '../logger.js';
import { renewLease, runExclusive, startJob, type JobOutcome } from './jobs.js';
import { inDemoContext } from './demoPolicy.js';
import { realSleep, type SourceHttp } from './catalogSources/http.js';
import { defaultClassificationModel, defaultModelAvailable, type ClassificationModel } from './catalogClassify.js';
import { loadBlockedTitles, loadRunContext } from './catalogRefreshContext.js';
import { runAllSources } from './catalogRefreshSources.js';
import type { RunState } from './catalogRefreshChunk.js';
import { notifyOperators } from './catalogRefreshEmail.js';
import { parseCursor, parseStats, type SourceKey } from './catalogRefreshState.js';
import {
  CATALOG_REFRESH_LEASE, claimRun, failRun, finishRun, isCatalogRefreshActive, saveRunProgress, shouldRunScheduledCatalogRefresh,
  type ClaimedRun, type RunTrigger,
} from './catalogRefreshRun.js';

/**
 * The monthly shared-catalog refresh: read outside sources, queue proposals,
 * tell the owner. Nothing reaches the catalog here; approval does that
 * (services/catalogProposals.ts).
 */

export { isCatalogRefreshActive, shouldRunScheduledCatalogRefresh } from './catalogRefreshRun.js';

export const CATALOG_REFRESH_SCHEDULE = { name: 'catalog-refresh-schedule', intervalMs: 6 * 60 * 60_000, ttlMs: 5 * 60_000 } as const;
const ONET_CHUNK_SIZE = 100;

export interface CatalogRefreshDeps {
  readonly http: SourceHttp;
  readonly model: ClassificationModel;
  readonly modelAvailable: boolean;
  readonly researchKey: string;
  readonly demo: boolean;
  readonly now: () => Date;
  readonly onetChunkSize: number;
  /** Test hook: runs after each chunk is saved; throwing simulates a crash. */
  readonly afterChunk?: (source: SourceKey) => Promise<void>;
}

class LeaseLostError extends Error {
  constructor() { super('Catalog refresh lease was lost to another instance; stopping so it can resume the run.'); }
}

let testOverrides: Partial<CatalogRefreshDeps> | null = null;

/** Test hook: the deps a run gets when its caller passes none (the HTTP route, the schedule). */
export function _setCatalogRefreshDepsForTest(overrides: Partial<CatalogRefreshDeps> | null): void {
  testOverrides = overrides;
}

function resolveDeps(overrides: Partial<CatalogRefreshDeps> = {}): CatalogRefreshDeps {
  const defaults: CatalogRefreshDeps = {
    http: { fetch: globalThis.fetch, sleep: realSleep, timeoutMs: config.catalogRefresh.fetchTimeoutMs },
    model: defaultClassificationModel,
    modelAvailable: defaultModelAvailable(),
    researchKey: config.llm.openaiKey,
    demo: inDemoContext(),
    now: () => new Date(),
    onetChunkSize: ONET_CHUNK_SIZE,
  };
  return { ...defaults, ...testOverrides, ...overrides };
}

async function initialState(run: ClaimedRun, now: Date): Promise<RunState> {
  return {
    cursor: parseCursor(run.cursorJson),
    stats: parseStats(run.statsJson),
    llmCalls: run.llmCalls,
    researchCalls: run.researchCalls,
    blocked: await loadBlockedTitles(now),
  };
}

async function executeRun(run: ClaimedRun, deps: CatalogRefreshDeps): Promise<string> {
  const ctx = await loadRunContext(run.id);
  const checkpoint = async (state: RunState, source: SourceKey) => {
    await saveRunProgress(run.id, state);
    // Long runs outlive the lease TTL; renewing after each chunk keeps a
    // second instance from starting the same run alongside this one.
    if (!(await renewLease(CATALOG_REFRESH_LEASE.name, CATALOG_REFRESH_LEASE.ttlMs))) throw new LeaseLostError();
    await deps.afterChunk?.(source);
  };
  const final = await runAllSources({
    ctx, http: deps.http, onetChunkSize: deps.onetChunkSize, checkpoint,
    model: { model: deps.model, modelAvailable: deps.modelAvailable },
    research: { apiKey: deps.researchKey, demo: deps.demo },
  }, await initialState(run, deps.now()));
  await saveRunProgress(run.id, final);
  await finishRun(run.id, deps.now());
  await notifyOperators(run.id);
  const proposed = final.stats.onet.proposed + final.stats.esco.proposed + final.stats.web.proposed;
  return `catalog refresh ${run.id}: ${proposed} proposals`;
}

export interface RunCatalogRefreshOptions {
  readonly trigger: RunTrigger;
  readonly triggeredById?: string;
  readonly deps?: Partial<CatalogRefreshDeps>;
  /** Called once the run row exists, before any source is read. */
  readonly onStarted?: (runId: string) => void;
}

/**
 * One run under the 'catalog-refresh' lease: a second caller while one is
 * running gets 'skipped'. Never throws; a failure is recorded on the run (so
 * the next attempt resumes it) and on the job log, which alerts the operator.
 */
export async function runCatalogRefresh(opts: RunCatalogRefreshOptions): Promise<{ readonly outcome: JobOutcome; readonly runId?: string }> {
  const deps = resolveDeps(opts.deps);
  let runId: string | undefined;
  const outcome = await runExclusive(CATALOG_REFRESH_LEASE.name, CATALOG_REFRESH_LEASE.ttlMs, async () => {
    const run = await claimRun(opts.trigger, opts.triggeredById, deps.now());
    runId = run.id;
    opts.onStarted?.(run.id);
    try {
      return await executeRun(run, deps);
    } catch (err) {
      if (!(err instanceof LeaseLostError)) await failRun(run.id, err instanceof Error ? err.message : String(err), deps.now());
      throw err;
    }
  });
  return { outcome, runId };
}

let inFlight: Promise<unknown> = Promise.resolve();

/** Test hook: resolves once the last background run started here has ended. */
export function _catalogRefreshSettled(): Promise<unknown> {
  return inFlight;
}

export type ManualStart = { readonly kind: 'started'; readonly runId: string } | { readonly kind: 'busy' } | { readonly kind: 'failed' };

/**
 * Start a manual run in the background and resolve as soon as it has a run
 * id, so the HTTP request is not held for a run that can take many minutes.
 */
export async function startManualCatalogRefresh(triggeredById: string, deps?: Partial<CatalogRefreshDeps>): Promise<ManualStart> {
  if (await isCatalogRefreshActive(new Date())) return { kind: 'busy' };
  return new Promise<ManualStart>((resolve) => {
    const run = runCatalogRefresh({ trigger: 'manual', triggeredById, deps, onStarted: (runId) => resolve({ kind: 'started', runId }) })
      // No run id: either another run held the lease, or the run could not even be recorded.
      .then((result) => { if (!result.runId) resolve(result.outcome === 'skipped' ? { kind: 'busy' } : { kind: 'failed' }); })
      .catch((err: unknown) => {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Manual catalog refresh could not run');
        resolve({ kind: 'failed' });
      });
    inFlight = run;
  });
}

/** The 6-hourly tick: runs only when due, so the effect is monthly and survives restarts. */
export async function scheduledCatalogRefreshTick(deps?: Partial<CatalogRefreshDeps>): Promise<string> {
  if (!(await shouldRunScheduledCatalogRefresh(new Date()))) return 'not due';
  const result = await runCatalogRefresh({ trigger: 'schedule', deps });
  return `${result.outcome}${result.runId ? ` ${result.runId}` : ''}`;
}

export function startCatalogRefreshSchedule(): () => void {
  return startJob({ ...CATALOG_REFRESH_SCHEDULE, delayFirst: true, fn: () => scheduledCatalogRefreshTick() });
}
