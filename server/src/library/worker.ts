import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getLlm, type LlmProvider } from '../providers/llm/index.js';
import { LlmApiError } from '../providers/llm/types.js';
import { alertOperator, INSTANCE_ID, runExclusive, type JobOutcome, type LeaseHandle } from '../services/jobs.js';
import { budgetStatus, msUntilNextUtcDay, recordTokens, releaseCalls, reserveCalls, type BudgetRefusal } from './budget.js';
import { CriticUnavailableError, criticConfigFromEnv, deterministicCritic, llmCritic, modelFamily, resolveCriticProvider, type CriticModel } from './critic.js';
import { checkDuplicate, dedupeWithinBatch, LexicalShingleBackend, type SimilarityBackend } from './dedupe.js';
import { loadDemandQueue, type DemandPool } from './demand.js';
import { BATCH_SIZE, deterministicGenerator, GENERATOR_PROMPT_VERSION, llmGenerator, type GeneratorModel, type PoolContext } from './generator.js';
import { lintAnchors, lintQuestionText } from './linter.js';
import { decideGate, loadPolicy, loadStratum, saveStratum, statusForOutcome, stratumAfterGated, type StratumState } from './policy.js';
import { nextFormsFor, recomputePoolTargets } from './poolTargets.js';
import { stratumKeyOf, type LibraryPolicySettings, type WorkerState } from './types.js';
import { setWorkerState } from './workerState.js';

/**
 * The fill worker. Runs in its own process (workerMain.ts), never on the API
 * request path. One lease, `library-worker`, so two workers never overlap;
 * budgets in calls per day and tokens per 30 days; progress saved per batch;
 * SIGTERM finishes the batch in flight and stops.
 *
 * States: running, idle (queue empty), paused (cap or generator), waiting_for_credits
 * (429 insufficient_quota — retried hourly, never hammered), critic_unavailable,
 * stopped.
 */

export const LIBRARY_WORKER_LEASE = { name: 'library-worker', ttlMs: 10 * 60_000 } as const;
/** Reserved per batch: generator + critic, plus the standard when a family lacks one. Unused calls are released. */
const CALLS_RESERVED_PER_BATCH = 3;
/** A batch of ten runs to roughly this many tokens; the rolling cap keeps this much room per batch in flight. */
const TOKENS_PER_BATCH_ESTIMATE = 20_000;
const IDLE_SLEEP_MS = 5 * 60_000;
const CREDITS_RETRY_MS = 60 * 60_000;
const ERROR_BACKOFF_MS = 60_000;
/** Failed iterations in a row before the operator hears; one bad batch is noise. */
const ALERT_AFTER_FAILURES = 3;
const TARGETS_REFRESH_MS = 24 * 60 * 60_000;
/** Existing questions compared for duplicates: the pool plus its family, capped so a batch stays cheap. */
const DEDUPE_CANDIDATES = 400;

export interface WorkerDeps {
  readonly generator: GeneratorModel;
  readonly generatorFamily: ReturnType<typeof modelFamily>;
  readonly generatorEnabled: boolean;
  /** Resolves the critic per batch so a key added while running is picked up; throws CriticUnavailableError. */
  readonly critic: () => CriticModel;
  readonly similarity: SimilarityBackend;
  readonly loadQueue: (now: Date) => Promise<DemandPool[]>;
  readonly caps: { readonly dailyCap: number; readonly monthlyCap: number };
  readonly concurrency: number;
  readonly batchSize: number;
  readonly now: () => Date;
  /** Interruptible: resolves early when the worker is asked to stop. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly leaseTtlMs: number;
  readonly heartbeatMs: number;
  /** Stop after this many loop iterations (tests, the smoke script). */
  readonly maxIterations?: number;
  readonly recomputeTargets: (now: Date) => Promise<number>;
  /** Tells the operator the worker keeps failing (throttled to once an hour by default). */
  readonly alert: (message: string) => Promise<void>;
}

/** Provider calls a batch has made so far, so an unused reservation can be given back after a failure. */
export interface Spend {
  calls: number;
}

export interface BatchResult {
  readonly pool: string;
  readonly generated: number;
  readonly probational: number;
  readonly queued: number;
  readonly rejected: number;
  readonly standardCreated: boolean;
  readonly tokens: { readonly input: number; readonly output: number };
}

export function defaultWorkerDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  const llm: LlmProvider = getLlm();
  const generatorModel = config.llm.provider === 'anthropic' ? config.llm.anthropicModel : config.llm.openaiModel;
  const generatorFamily = modelFamily(llm.name, generatorModel);
  const leaseTtlMs = overrides.leaseTtlMs ?? LIBRARY_WORKER_LEASE.ttlMs;
  return {
    generator: llmGenerator(llm),
    generatorFamily,
    generatorEnabled: llm.enabled,
    critic: () => llmCritic(resolveCriticProvider(criticConfigFromEnv(), { family: generatorFamily })),
    similarity: new LexicalShingleBackend(),
    loadQueue: loadDemandQueue,
    caps: { dailyCap: config.library.dailyCallCap, monthlyCap: config.library.monthlyTokenCap },
    concurrency: config.library.workerConcurrency,
    batchSize: BATCH_SIZE,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    leaseTtlMs,
    heartbeatMs: Math.max(1000, Math.floor(leaseTtlMs / 3)),
    recomputeTargets: recomputePoolTargets,
    alert: (message) => alertOperator(LIBRARY_WORKER_LEASE.name, message),
    ...overrides,
  };
}

/** Test deps: templated generator and rule-based critic, no provider, no sleeping. */
export function testWorkerDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return defaultWorkerDeps({
    generator: deterministicGenerator(),
    generatorFamily: 'openai',
    generatorEnabled: true,
    critic: () => deterministicCritic(),
    sleep: async () => undefined,
    leaseTtlMs: 60_000,
    heartbeatMs: 20_000,
    recomputeTargets: async () => 0,
    ...overrides,
  });
}

// --- One batch ---------------------------------------------------------------------

async function ensureStandard(pool: DemandPool, ctx: PoolContext, deps: WorkerDeps, spend: Spend): Promise<{ readonly id: string; readonly anchors: string[]; readonly created: boolean; readonly tokens: { input: number; output: number } }> {
  const existing = await prisma.libraryStandard.findFirst({ where: { familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band, status: 'live' }, orderBy: { version: 'desc' } });
  if (existing) return { id: existing.id, anchors: parseAnchors(existing.anchorsJson), created: false, tokens: { input: 0, output: 0 } };
  spend.calls += 1;
  const { standard, usage } = await deps.generator.generateStandard(ctx);
  // Recorded before anything can fail: the tokens are spent whether or not the batch is written.
  await recordTokens({ input: usage.inputTokens, output: usage.outputTokens }, deps.now());
  const lint = lintAnchors(standard.anchors);
  if (!lint.ok) throw new Error(`standard failed lint: ${lint.errors.map((e) => e.code).join(',')}`);
  const created = await prisma.libraryStandard.create({
    data: {
      familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band,
      anchorsJson: JSON.stringify({ anchors: standard.anchors, weakSigns: standard.weakSigns }),
      generatorPromptVersion: GENERATOR_PROMPT_VERSION, generatorModel: usage.model,
    },
  });
  return { id: created.id, anchors: [...standard.anchors], created: true, tokens: { input: usage.inputTokens, output: usage.outputTokens } };
}

function parseAnchors(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((a): a is string => typeof a === 'string');
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { anchors?: unknown }).anchors)) {
      return (parsed as { anchors: unknown[] }).anchors.filter((a): a is string => typeof a === 'string');
    }
  } catch {
    // A corrupt standard is treated as empty; the linter refuses to write entries without anchors.
  }
  return [];
}

async function existingQuestions(pool: DemandPool): Promise<{ readonly id: string; readonly text: string }[]> {
  const rows = await prisma.libraryEntry.findMany({
    where: {
      competencyKey: pool.competencyKey, band: pool.band, status: { not: 'rejected' },
      OR: [{ roleSlug: pool.roleSlug }, { familySlug: pool.familySlug }],
    },
    orderBy: { createdAt: 'desc' },
    take: DEDUPE_CANDIDATES,
    select: { id: true, questionText: true },
  });
  return rows.map((r) => ({ id: r.id, text: r.questionText }));
}

async function stratumFor(cache: Map<string, StratumState>, key: string): Promise<StratumState> {
  const cached = cache.get(key);
  if (cached) return cached;
  const loaded = await loadStratum(key);
  cache.set(key, loaded);
  return loaded;
}

export async function runBatch(pool: DemandPool, deps: WorkerDeps, policy: LibraryPolicySettings, spend: Spend = { calls: 0 }): Promise<BatchResult> {
  const ctx: PoolContext = {
    pool: { scope: pool.scope, tenantId: pool.tenantId, roleSlug: pool.roleSlug, familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band },
    roleTitle: pool.roleTitle, familyName: pool.familyName, competency: pool.competency, band: pool.band as PoolContext['band'], jdText: pool.jdText,
    existingQuestions: [],
  };
  const critic = deps.critic();
  const existing = await existingQuestions(pool);
  const context = { ...ctx, existingQuestions: existing.map((e) => e.text) };
  const standard = await ensureStandard(pool, context, deps, spend);
  const wanted = Math.min(deps.batchSize, Math.max(1, pool.target - pool.filled));
  const forms = nextFormsFor(pool.formCounts, wanted);
  spend.calls += 1;
  const generated = await deps.generator.generateQuestions(context, forms, standard.anchors);
  await recordTokens({ input: generated.usage.inputTokens, output: generated.usage.outputTokens }, deps.now());
  const dropped = await dedupeWithinBatch(generated.questions.map((q) => q.questionText), { near: policy.nearDuplicate, duplicate: policy.duplicate }, deps.similarity);
  const questions = generated.questions.filter((_q, i) => !dropped.has(i));
  spend.calls += 1;
  const critique = await critic.critique(context, questions, standard.anchors);
  await recordTokens({ input: critique.usage.inputTokens, output: critique.usage.outputTokens }, deps.now());
  const strata = new Map<string, StratumState>();
  const counts = { probational: 0, queued: 0, rejected: 0 };

  for (const [i, question] of questions.entries()) {
    const lint = lintQuestionText(question.questionText);
    const dedupe = await checkDuplicate(question.questionText, existing, { near: policy.nearDuplicate, duplicate: policy.duplicate }, deps.similarity);
    const stratumKey = stratumKeyOf({ scope: pool.scope, roleSlug: pool.roleSlug, band: pool.band, form: question.form, generatorPromptVersion: GENERATOR_PROMPT_VERSION });
    const stratum = await stratumFor(strata, stratumKey);
    const verdict = critique.verdicts[i] ?? null;
    const decision = decideGate({ critic: verdict, lint, dedupe, stratum, policy });
    const status = statusForOutcome(decision.outcome);
    const entry = await prisma.libraryEntry.create({
      data: {
        scope: pool.scope, tenantId: pool.tenantId, roleSlug: pool.roleSlug, familySlug: pool.familySlug, competencyKey: pool.competencyKey, band: pool.band,
        form: question.form, questionText: question.questionText,
        bodyJson: JSON.stringify({ anchors: standard.anchors, rationale: question.rationale }),
        status, gateOutcome: decision.outcome, gateReason: decision.reasons.join(','), stratumKey,
        difficultyTag: question.difficultyTag, standardId: standard.id,
        generatorPromptVersion: GENERATOR_PROMPT_VERSION, generatorModel: generated.usage.model,
        criticModel: critique.usage.model, criticVerdictJson: JSON.stringify(verdict ?? {}),
        policyVersion: policy.version, createdBy: 'worker',
      },
    });
    await prisma.libraryReview.create({
      data: { entryId: entry.id, actor: 'policy', action: 'gated', fromStatus: 'draft', toStatus: status, reason: decision.reasons.join(',').slice(0, 1000), sampleStratum: stratumKey },
    });
    if (decision.outcome === 'unsure' && stratum.tightenedRemaining > 0) strata.set(stratumKey, stratumAfterGated(stratum));
    // Later questions in the batch are compared against earlier ones too.
    existing.push({ id: entry.id, text: entry.questionText });
    counts[decision.outcome === 'pass' ? 'probational' : decision.outcome === 'unsure' ? 'queued' : 'rejected'] += 1;
  }
  for (const [key, state] of strata) await saveStratum(key, state);
  const tokens = {
    input: standard.tokens.input + generated.usage.inputTokens + critique.usage.inputTokens,
    output: standard.tokens.output + generated.usage.outputTokens + critique.usage.outputTokens,
  };
  return { pool: `${pool.roleSlug}|${pool.competencyKey}|${pool.band}`, generated: questions.length, ...counts, standardCreated: standard.created, tokens };
}

// --- The loop --------------------------------------------------------------------------

export interface WorkerControl {
  readonly stopped: () => boolean;
}

export type LoopExit = 'stopped' | 'lease_lost' | 'iterations';

/** `failed`: the pause follows an error, not a cap, a quota or an empty queue. */
type Pause = { readonly state: WorkerState; readonly reason: string; readonly ms: number; readonly failed?: boolean };

function pauseFor(err: unknown, now: Date): Pause | null {
  if (err instanceof LlmApiError && err.insufficientQuota) return { state: 'waiting_for_credits', reason: `${err.provider} 429 insufficient_quota`, ms: CREDITS_RETRY_MS };
  if (err instanceof LlmApiError && err.rateLimited) return { state: 'paused', reason: `${err.provider} rate limited`, ms: ERROR_BACKOFF_MS * 5 };
  if (err instanceof CriticUnavailableError) return { state: 'critic_unavailable', reason: err.reason, ms: CREDITS_RETRY_MS };
  void now;
  return null;
}

function pauseForBudget(reason: BudgetRefusal, now: Date): Pause {
  return reason === 'daily_cap'
    ? { state: 'paused', reason: 'daily call cap reached', ms: msUntilNextUtcDay(now) + 1000 }
    : { state: 'paused', reason: 'rolling 30-day token cap reached', ms: 6 * 60 * 60_000 };
}

type Outcome = { readonly ok: true; readonly result: BatchResult; readonly spend: Spend } | { readonly ok: false; readonly err: unknown; readonly spend: Spend };

async function runOne(pool: DemandPool, deps: WorkerDeps, policy: LibraryPolicySettings): Promise<Outcome> {
  const spend: Spend = { calls: 0 };
  try {
    return { ok: true, result: await runBatch(pool, deps, policy, spend), spend };
  } catch (err) {
    return { ok: false, err, spend };
  }
}

/**
 * One pass: pick up to `concurrency` pools, reserve their calls, run them side
 * by side, and decide whether to sleep. Returns how long to sleep, or null
 * when it should go straight on.
 */
async function iteration(deps: WorkerDeps, holder: string): Promise<Pause | null> {
  const now = deps.now();
  if (!deps.generatorEnabled) return { state: 'paused', reason: 'generator_unavailable: LLM_PROVIDER has no key', ms: CREDITS_RETRY_MS };
  // The critic is resolved before any spend, so a missing key costs nothing.
  try {
    deps.critic();
  } catch (err) {
    const pause = pauseFor(err, now);
    if (pause) return pause;
    throw err;
  }
  const queue = await deps.loadQueue(now);
  if (queue.length === 0) return { state: 'idle', reason: 'every pool at target', ms: IDLE_SLEEP_MS };
  const policy = await loadPolicy();
  const picked = queue.slice(0, Math.max(1, deps.concurrency));
  const reserved: DemandPool[] = [];
  for (const pool of picked) {
    const room = await reserveCalls(deps.caps, CALLS_RESERVED_PER_BATCH, TOKENS_PER_BATCH_ESTIMATE * (reserved.length + 1), now);
    if (!room.ok) {
      if (reserved.length === 0) return pauseForBudget(room.reason ?? 'daily_cap', now);
      break;
    }
    reserved.push(pool);
  }
  await setWorkerState('running', { reason: `${reserved.length} batch(es) in flight`, holder });
  const outcomes = await Promise.all(reserved.map((pool) => runOne(pool, deps, policy)));
  let pause: Pause | null = null;
  for (const [i, outcome] of outcomes.entries()) {
    // Whatever happened, calls reserved but never made go back to the day.
    const unused = CALLS_RESERVED_PER_BATCH - outcome.spend.calls;
    if (unused > 0) await releaseCalls(unused, now);
    if (outcome.ok) {
      const r = outcome.result;
      logger.info({ pool: r.pool, generated: r.generated, probational: r.probational, queued: r.queued, rejected: r.rejected }, 'Library batch written');
      await setWorkerState('running', { holder, batchFinished: true, reason: `last: ${r.pool}` });
      continue;
    }
    const message = outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
    logger.error({ pool: reserved[i].roleSlug, err: message.slice(0, 300) }, 'Library batch failed');
    await setWorkerState('running', { holder, lastError: message });
    pause = pause ?? pauseFor(outcome.err, now) ?? { state: 'paused', reason: `batch failed: ${message.slice(0, 120)}`, ms: ERROR_BACKOFF_MS, failed: true };
  }
  return pause;
}

export async function runWorkerLoop(deps: WorkerDeps, lease: LeaseHandle, control: WorkerControl): Promise<LoopExit> {
  let iterations = 0;
  let targetsAt = 0;
  let lost = false;
  let failuresInARow = 0;
  const heartbeat = setInterval(() => {
    lease.renew(deps.leaseTtlMs).then((held) => { if (!held) lost = true; }).catch(() => { lost = true; });
  }, deps.heartbeatMs);
  heartbeat.unref?.();
  try {
    while (!control.stopped()) {
      if (lost) return 'lease_lost';
      if (deps.maxIterations !== undefined && iterations >= deps.maxIterations) return 'iterations';
      iterations += 1;
      const now = deps.now().getTime();
      if (now - targetsAt >= TARGETS_REFRESH_MS) {
        targetsAt = now;
        await deps.recomputeTargets(deps.now()).catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Library pool targets not recomputed'));
      }
      const pause = await iteration(deps, lease.holder).catch((err: unknown): Pause => ({ state: 'paused', reason: `worker error: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`, ms: ERROR_BACKOFF_MS, failed: true }));
      // The loop never throws to runExclusive, so its own alert would never
      // fire: a worker failing every batch would show only in the logs.
      failuresInARow = pause?.failed ? failuresInARow + 1 : 0;
      if (failuresInARow >= ALERT_AFTER_FAILURES) {
        await deps.alert(`${failuresInARow} library batches failed in a row. Last: ${pause?.reason ?? ''}`)
          .catch((err: unknown) => logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not alert about library worker failures'));
      }
      if (pause) {
        await setWorkerState(pause.state, { reason: pause.reason, holder: lease.holder });
        logger.info({ state: pause.state, reason: pause.reason, sleepMs: pause.ms }, 'Library worker pausing');
        await deps.sleep(pause.ms);
      }
    }
    return 'stopped';
  } finally {
    clearInterval(heartbeat);
  }
}

/** Take the lease and run the loop; 'skipped' when another worker holds it. */
export async function runWorkerUnderLease(deps: WorkerDeps, control: WorkerControl): Promise<{ readonly outcome: JobOutcome; readonly exit?: LoopExit }> {
  let exit: LoopExit | undefined;
  const outcome = await runExclusive(LIBRARY_WORKER_LEASE.name, deps.leaseTtlMs, async (lease) => {
    await setWorkerState('running', { reason: 'starting', holder: lease.holder });
    try {
      exit = await runWorkerLoop(deps, lease, control);
      return `library worker ${exit}`;
    } finally {
      // A bounded run (tests, the smoke script) leaves its last state on show; a
      // real exit is what "stopped" means.
      if (exit !== 'iterations') await setWorkerState('stopped', { reason: exit ?? 'error', holder: '' }).catch(() => undefined);
    }
  });
  if (outcome === 'skipped') logger.info({ instance: INSTANCE_ID }, 'Library worker lease held elsewhere; not starting');
  return { outcome, exit };
}

/** For the admin screen and the smoke script: where the budget stands right now. */
export function currentBudget(now = new Date()) {
  return budgetStatus({ dailyCap: config.library.dailyCallCap, monthlyCap: config.library.monthlyTokenCap }, now);
}
