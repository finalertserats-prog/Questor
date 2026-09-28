import { config } from '../config.js';
import { logger } from '../logger.js';
import { jobsStopped, runExclusive, startJob, type JobOutcome, type LeaseHandle } from './jobs.js';
import { isDraining } from './drainState.js';
import { inDemoContext } from './demoPolicy.js';
import { realSleep, type SourceHttp } from './catalogSources/http.js';
import { defaultClassificationModel, defaultModelAvailable, type ClassificationModel } from './catalogClassify.js';
import { loadBlockedTitles, loadRunContext } from './catalogRefreshContext.js';
import { runAllSources } from './catalogRefreshSources.js';
import type { RunState } from './catalogRefreshChunk.js';
import { notifyOperators } from './catalogRefreshEmail.js';
import { parseCursor, parseStats, type SourceKey } from './catalogRefreshState.js';
import {
  CATALOG_REFRESH_LEASE, claimRun, failRun, finishRun, isCatalogRefreshActive, manualRunAllowedAt, markNoticeNotSent, queuedCounts, saveRunProgress,
  shouldRunScheduledCatalogRefresh, spendLimits, type ClaimedRun, type RunTrigger,
} from './catalogRefreshRun.js';

/**
 * The monthly shared-catalog refresh: read outside sources, queue proposals,
 * tell the owner. Nothing reaches the catalog here; approval does that
 * (services/catalogProposalReview.ts).
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
  readonly leaseTtlMs: number;
  /** How often the lease is renewed while work is in flight, chunk or not. */
  readonly heartbeatMs: number;
  /** Test hook: runs after each chunk is saved; throwing simulates a crash. */
  readonly afterChunk?: (source: SourceKey) => Promise<void>;
}

/**
 * Thrown at a checkpoint when this process must stop without failing the run:
 * the lease went to another holder, or the process is draining. The run row
 * stays 'running' and the next holder resumes it from the saved cursor.
 */
class StopForResume extends Error {
  constructor(readonly reason: 'lease_lost' | 'draining') { super(`Catalog refresh stopped for resume: ${reason}`); }
}

let testOverrides: Partial<CatalogRefreshDeps> | null = null;

/** Test hook: the deps a run gets when its caller passes none (the HTTP route, the schedule). */
export function _setCatalogRefreshDepsForTest(overrides: Partial<CatalogRefreshDeps> | null): void {
  testOverrides = overrides;
}

function resolveDeps(overrides: Partial<CatalogRefreshDeps> = {}): CatalogRefreshDeps {
  const leaseTtlMs = overrides.leaseTtlMs ?? testOverrides?.leaseTtlMs ?? CATALOG_REFRESH_LEASE.ttlMs;
  const defaults: CatalogRefreshDeps = {
    http: { fetch: globalThis.fetch, sleep: realSleep, timeoutMs: config.catalogRefresh.fetchTimeoutMs },
    model: defaultClassificationModel,
    modelAvailable: defaultModelAvailable(),
    researchKey: config.llm.openaiKey,
    demo: inDemoContext(),
    now: () => new Date(),
    onetChunkSize: ONET_CHUNK_SIZE,
    leaseTtlMs,
    heartbeatMs: Math.max(10, Math.floor(leaseTtlMs / 3)),
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
    queued: await queuedCounts(run.id),
  };
}

/**
 * Renew the lease on a timer for as long as the run works, so a chunk slower
 * than the TTL (a stalled source, a slow model) never lets a second executor
 * take the same run. A failed renewal is remembered and ends the run at the
 * next checkpoint.
 */
function startHeartbeat(lease: LeaseHandle, deps: CatalogRefreshDeps) {
  let lost = false;
  const timer = setInterval(() => {
    lease.renew(deps.leaseTtlMs)
      .then((held) => { if (!held) lost = true; })
      .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Catalog refresh lease renewal failed'));
  }, deps.heartbeatMs);
  timer.unref?.();
  return { lost: () => lost, stop: () => clearInterval(timer) };
}

async function executeRun(run: ClaimedRun, lease: LeaseHandle, deps: CatalogRefreshDeps): Promise<string> {
  const limits = await spendLimits(run, deps.now());
  const ctx = await loadRunContext(run.id, limits);
  const heartbeat = startHeartbeat(lease, deps);
  const checkpoint = async (state: RunState, source: SourceKey) => {
    // Another holder has the run now: saving would overwrite its progress.
    if (heartbeat.lost() || !(await lease.renew(deps.leaseTtlMs))) throw new StopForResume('lease_lost');
    await saveRunProgress(run.id, state);
    if (isDraining() || jobsStopped()) throw new StopForResume('draining');
    await deps.afterChunk?.(source);
  };
  try {
    const final = await runAllSources({
      ctx, http: deps.http, onetChunkSize: deps.onetChunkSize, checkpoint,
      model: { model: deps.model, modelAvailable: deps.modelAvailable },
      research: { apiKey: deps.researchKey, demo: deps.demo },
    }, await initialState(run, deps.now()));
    await saveRunProgress(run.id, final);
    await finishRun(run.id, deps.now());
    const proposed = final.stats.onet.proposed + final.stats.esco.proposed + final.stats.web.proposed;
    if (await notifyOperators(run.id)) return `catalog refresh ${run.id}: ${proposed} proposals`;
    // The run finished; only the notice is missing, so the review page says so
    // instead of the proposals waiting on approval nobody was told about.
    await markNoticeNotSent(run.id).catch((err: unknown) => {
      logger.error({ runId: run.id, err: err instanceof Error ? err.message : String(err) }, 'Could not record the unsent catalog refresh notice');
    });
    return `catalog refresh ${run.id}: ${proposed} proposals; operator notice not sent`;
  } finally {
    heartbeat.stop();
  }
}

export interface RunCatalogRefreshOptions {
  readonly trigger: RunTrigger;
  readonly triggeredById?: string;
  readonly deps?: Partial<CatalogRefreshDeps>;
  /** Called once the run row exists, before any source is read. */
  readonly onStarted?: (runId: string) => void;
}

// One executor per process, whatever the lease says: if a lease lapsed while
// this process was still working, its own next attempt must not start a
// second executor on the same run.
let executing = false;

async function runUnderLease(opts: RunCatalogRefreshOptions, deps: CatalogRefreshDeps, lease: LeaseHandle, setRunId: (id: string) => void): Promise<string> {
  const run = await claimRun(opts.trigger, opts.triggeredById, deps.now());
  setRunId(run.id);
  opts.onStarted?.(run.id);
  try {
    return await executeRun(run, lease, deps);
  } catch (err) {
    if (err instanceof StopForResume) {
      logger.warn({ runId: run.id, reason: err.reason }, 'Catalog refresh stopped; the next run resumes it');
      return `catalog refresh ${run.id}: stopped for resume (${err.reason})`;
    }
    logger.error({ runId: run.id, err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 'Catalog refresh failed');
    await failRun(run.id, 'unexpected_error', deps.now());
    throw err;
  }
}

/**
 * One run under the 'catalog-refresh' lease: a second caller while one is
 * running gets 'skipped'. Never throws; a failure is recorded on the run (so
 * the next attempt resumes it) and on the job log, which alerts the operator.
 */
export async function runCatalogRefresh(opts: RunCatalogRefreshOptions): Promise<{ readonly outcome: JobOutcome; readonly runId?: string }> {
  if (executing) return { outcome: 'skipped' };
  executing = true;
  try {
    const deps = resolveDeps(opts.deps);
    let runId: string | undefined;
    const outcome = await runExclusive(CATALOG_REFRESH_LEASE.name, deps.leaseTtlMs, (lease) => runUnderLease(opts, deps, lease, (id) => { runId = id; }));
    return { outcome, runId };
  } finally {
    executing = false;
  }
}

let inFlight: Promise<unknown> = Promise.resolve();

/** Test hook: resolves once the last background run started here has ended. */
export function _catalogRefreshSettled(): Promise<unknown> {
  return inFlight;
}

export type ManualStart =
  | { readonly kind: 'started'; readonly runId: string }
  | { readonly kind: 'busy' }
  | { readonly kind: 'too_soon'; readonly retryAt: Date }
  | { readonly kind: 'failed' };

/**
 * Start a manual run in the background and resolve as soon as it has a run
 * id, so the HTTP request is not held for a run that can take many minutes.
 * Manual runs are spaced out: each one reads the sources again.
 */
export async function startManualCatalogRefresh(triggeredById: string, deps?: Partial<CatalogRefreshDeps>): Promise<ManualStart> {
  const now = new Date();
  if (executing || await isCatalogRefreshActive(now)) return { kind: 'busy' };
  const allowedAt = await manualRunAllowedAt(now);
  if (allowedAt) return { kind: 'too_soon', retryAt: allowedAt };
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
