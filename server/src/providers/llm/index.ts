import { config, type LlmPurpose } from '../../config.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import type { LlmGenerateOptions, LlmProvider, LlmMessage, ReasoningEffort } from './types.js';
import { HeuristicLlmProvider } from './heuristic.js';
import { AnthropicLlmProvider } from './anthropic.js';
import { OpenAiLlmProvider } from './openai.js';
import { OllamaLlmProvider } from './ollama.js';
import { classifyLlmFailure, cooldownKindFor, shouldFailOver, type LlmFailureClass } from './failures.js';
import { admitLayer, layerTooSlow, recordLayerFailure, recordLayerReachable, recordStepDown, servingState, type LayerState, type ServingLayer } from './serving.js';
import { noteServed as recordServed } from './servingTrace.js';
import { alertLlmOutage, noteLlmRecovered } from './outageAlert.js';
import { inDemoContext, isHeuristicOnlySession } from '../../services/demoPolicy.js';

export type { LlmProvider, LlmMessage, ReasoningEffort } from './types.js';
export type { LlmPurpose } from '../../config.js';

/**
 * The ceiling on one call: its purpose's budget, which a caller may shorten
 * but never lengthen. There is no branch here that yields `undefined` — that
 * is what "a timeout by construction" means.
 */
export function budgetFor(purpose: LlmPurpose, tighterMs?: number): number {
  // `?? live_turn` is unreachable through the type, and is here so that a
  // caller reaching this from untyped JavaScript still gets the STRICTEST
  // budget rather than no budget. Silence mid-interview is the failure this
  // whole mechanism exists to prevent; defaulting loose would reintroduce it.
  const budget = config.llm.budgets[purpose] ?? config.llm.budgets.live_turn;
  return tighterMs && tighterMs > 0 ? Math.min(budget, tighterMs) : budget;
}

let cached: LlmProvider | null = null;

export function getLlm(): LlmProvider {
  if (cached) return cached;
  const p = config.llm.provider;
  if (p === 'anthropic' && config.llm.anthropicKey) {
    cached = new AnthropicLlmProvider(config.llm.anthropicKey, config.llm.anthropicModel);
  } else if (p === 'openai' && config.llm.openaiKey) {
    cached = new OpenAiLlmProvider(config.llm.openaiKey, config.llm.openaiModel, config.llm.openaiReasoningEffort);
  } else {
    if (p !== 'heuristic') {
      logger.warn(`LLM provider "${p}" selected but no API key set; falling back to heuristic engine.`);
    }
    cached = new HeuristicLlmProvider();
  }
  return cached;
}

// Test hook
export function _resetLlm() {
  cached = null;
}

/** Test hook: stand a fake provider in for the configured one; null restores the configured one. */
export function _setLlmForTests(provider: LlmProvider | null) {
  cached = provider;
}

let cachedLocal: LlmProvider | null = null;

/** The local model (Ollama), or null while LOCAL_LLM_ENABLED is off. */
function getLocalLlm(): LlmProvider | null {
  if (!config.llm.local.enabled) return null;
  cachedLocal ??= new OllamaLlmProvider(config.llm.local.url, config.llm.local.model, config.llm.local.keepAlive);
  return cachedLocal;
}

/** Test hook: stand a fake in for the local model; null restores the configured one. */
export function _setLocalLlmForTests(provider: LlmProvider | null) {
  cachedLocal = provider;
}

/**
 * The interviewer's spoken calls: the only ones the local model is trusted
 * with, and the ones recorded on the turn. Grading, reports and feedback
 * letters wait for the primary or take the built-in path, because a 3B model
 * on a CPU is not good enough to decide anything about a candidate.
 */
export const SPOKEN_FUNCTIONS: ReadonlySet<string> = new Set(['live_interviewer', 'candidate_question']);

/**
 * Every call made while a candidate waits for the next turn. These go through
 * the chain so a resting primary is skipped, not waited on. The intent read is
 * one of them but never goes to the local model: it runs alongside the spoken
 * turn, and on a 4-core CPU Ollama serves one request at a time, so it would
 * queue ahead of the turn the candidate is waiting for. Its pattern check (what
 * kept "stop" working with no model at all) still runs.
 */
export const CONVERSATIONAL_FUNCTIONS: ReadonlySet<string> = new Set([...SPOKEN_FUNCTIONS, 'candidate_intent']);

/**
 * Reject once `ms` has passed. The provider is asked to abort at the same
 * moment, but not every provider can (a hung socket, a fake in a test), and the
 * caller's promise is the one a candidate is waiting on — so the deadline is
 * enforced here as well, not only delegated.
 */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  // The deadline may win the race, and the abandoned call can still fail
  // afterwards: without a handler that failure is an unhandled rejection, which
  // takes the whole server down under Node's default policy.
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`model call exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export interface GenerateJsonOptions<T> {
  fn: string; // ModelExecution.function
  /**
   * What this call is for, which is what bounds it. Required, and there is no
   * "none": that is the whole point. Before this existed, eight of eleven call
   * sites passed no timeout and `work_sample` — which runs inside a live turn
   * — was observed open for 212 s (docs/qa/resilience-2026-09-23.md, R1).
   * Adding a call site without a bound is now a type error.
   */
  purpose: LlmPurpose;
  system: string;
  user: string;
  validate: (raw: unknown) => T;
  sessionId?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Tighten this one call below its purpose budget (a background job with its
   * own configured ceiling). It can only ever shorten the call: unset, or set
   * longer than the purpose allows, the purpose budget stands.
   */
  timeoutMs?: number;
  /** Override the configured reasoning effort for this call (reasoning models only). */
  reasoningEffort?: ReasoningEffort;
  /**
   * How the local fallback model handles this call, when LOCAL_LLM_ENABLED is
   * on: a glue-only variant with its own stricter check, or 'built-in' to keep
   * the call off the local model. Unset: the same prompt and check as the primary.
   */
  local?: LocalVariant<T> | 'built-in';
}

/**
 * The local model's version of a spoken call. It keeps the primary's system
 * prompt (the interviewer's persona and voice, so the style does not shift at
 * the switch) and adds an instruction confining it to glue around substance
 * the plan already holds.
 */
export interface LocalVariant<T> {
  /** Appended to the primary's system prompt. */
  systemSuffix: string;
  /** Appended to the primary's user message: the planned substance. */
  userSuffix?: string;
  /** Replaces the primary's check: what must be true before a local reply is spoken. */
  validate: (raw: unknown) => T;
}

/**
 * Ask the configured LLM for JSON, validate it, and log a ModelExecution row.
 * Returns null (never throws) so callers can fall back to their heuristic path.
 */
export async function generateJson<T>(opts: GenerateJsonOptions<T>): Promise<T | null> {
  const llm = getLlm();
  // Null unless LOCAL_LLM_ENABLED is on and this is a conversational call. With
  // it null, everything below is the path exactly as it was before the chain.
  const local = CONVERSATIONAL_FUNCTIONS.has(opts.fn) ? getLocalLlm() : null;
  if (!llm.enabled && !local) return null;
  // A demo never spends on a paid model: null is what every caller already
  // treats as "use the built-in heuristic engine".
  if (inDemoContext() || (await isHeuristicOnlySession(opts.sessionId))) return null;
  const messages: LlmMessage[] = [
    { role: 'system', content: opts.system + '\n\nRespond ONLY with valid minified JSON. No prose, no code fences.' },
    { role: 'user', content: opts.user },
  ];
  // The one place the ceiling is decided, for both the chain and the path
  // below it. A call reaching a provider without one is not representable.
  const timeoutMs = budgetFor(opts.purpose, opts.timeoutMs);
  if (local) return generateJsonWithFailover(opts, messages, llm, local, timeoutMs);
  try {
    const result = await withDeadline(
      llm.generate(messages, { temperature: opts.temperature ?? 0.3, maxTokens: opts.maxTokens, timeoutMs, reasoningEffort: opts.reasoningEffort }),
      timeoutMs,
    );
    const parsed = parseJsonLoose(result.text);
    const validated = opts.validate(parsed);
    await logModelExecution({
      sessionId: opts.sessionId ?? '',
      provider: llm.name,
      model: result.model,
      fn: opts.fn,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: result.latencyMs,
      safety: { ok: true },
    });
    return validated;
  } catch (err) {
    logger.warn({ err: String(err), fn: opts.fn }, 'LLM generateJson failed; using heuristic fallback');
    await logModelExecution({
      sessionId: opts.sessionId ?? '',
      provider: llm.name,
      model: 'unknown',
      fn: opts.fn,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      safety: { ok: false, error: String(err) },
    });
    return null;
  }
}

type Attempt<T> = { ok: true; value: T; callMs: number } | { ok: false; failure: LlmFailureClass };

/** One layer's try at the call: generate, parse, validate, log. Never throws. */
async function attemptJson<T>(
  provider: LlmProvider,
  messages: LlmMessage[],
  validate: (raw: unknown) => T,
  opts: GenerateJsonOptions<T>,
  callOpts: LlmGenerateOptions,
): Promise<Attempt<T>> {
  try {
    const began = Date.now();
    const result = await withDeadline(provider.generate(messages, callOpts), callOpts.timeoutMs);
    // The provider's time only: our own logging below must not make it look slow.
    const callMs = Date.now() - began;
    const value = validate(parseJsonLoose(result.text));
    await logModelExecution({
      sessionId: opts.sessionId ?? '', provider: provider.name, model: result.model, fn: opts.fn,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: result.latencyMs, safety: { ok: true },
    });
    return { ok: true, value, callMs };
  } catch (err) {
    const failure = classifyLlmFailure(err);
    logger.warn({ err: String(err), fn: opts.fn, provider: provider.name, failure }, 'LLM call failed');
    await logModelExecution({
      sessionId: opts.sessionId ?? '', provider: provider.name, model: 'unknown', fn: opts.fn,
      inputTokens: 0, outputTokens: 0, latencyMs: 0, safety: { ok: false, error: String(err), failureClass: failure },
    });
    return { ok: false, failure };
  }
}

/** Below this much of the turn left, a local attempt would only end in silence: the built-in writer takes it. */
const MIN_LOCAL_ATTEMPT_MS = 2_000;

/** Rest a failed layer (with backoff) and say so. */
function restLayer(layer: ServingLayer, provider: string, failure: LlmFailureClass, fn: string): void {
  const base = cooldownKindFor(failure) === 'long' ? config.llm.local.outageCooldownMs : config.llm.local.transientCooldownMs;
  const restMs = recordLayerFailure(layer, failure, Date.now(), base, config.llm.local.maxCooldownMs);
  logger.warn({ layer, provider, failure, fn, restMs }, 'LLM layer failed; resting it and stepping down');
}

function noteReachable(layer: ServingLayer, provider: string, slow = false): void {
  if (!recordLayerReachable(layer, slow)) return;
  logger.info({ layer, provider }, 'LLM layer answering again');
  if (layer === 'primary') noteLlmRecovered();
}

/** The local model's version of the call: the same persona prompt plus the glue instruction. */
function localMessages(messages: LlmMessage[], variant: LocalVariant<unknown> | undefined): LlmMessage[] {
  if (!variant) return messages;
  return messages.map((m) => {
    if (m.role === 'system') return { ...m, content: `${m.content}\n\n${variant.systemSuffix}` };
    if (m.role === 'user' && variant.userSuffix) return { ...m, content: `${m.content}\n\n${variant.userSuffix}` };
    return m;
  });
}

/**
 * The failover chain for a conversational call: primary -> local model ->
 * built-in writer (null), inside one turn budget (the caller's timeout).
 *
 * A layer that fails for a reason another layer can avoid is rested, with
 * backoff, and the next layer takes the request; any other failure goes to the
 * built-in writer, as it always has. The local model gets the same persona
 * prompt plus the caller's glue instruction and stricter check, one retry on a
 * reply that fails that check, and only what is left of the turn budget.
 */
async function generateJsonWithFailover<T>(opts: GenerateJsonOptions<T>, messages: LlmMessage[], primary: LlmProvider, local: LlmProvider, timeoutMs: number): Promise<T | null> {
  // Only what is spoken is recorded on the turn; the intent read is not.
  const noteServed = SPOKEN_FUNCTIONS.has(opts.fn) ? recordServed : () => {};
  const budgetEnd = Date.now() + timeoutMs;
  const shared = { temperature: opts.temperature ?? 0.3, maxTokens: opts.maxTokens };
  let failure: LlmFailureClass | undefined;

  if (primary.enabled && admitLayer('primary', Date.now())) {
    const outcome = await attemptJson(primary, messages, opts.validate, opts, { ...shared, timeoutMs, reasoningEffort: opts.reasoningEffort });
    if (outcome.ok || !shouldFailOver(outcome.failure)) {
      // An answer that arrived is used, however slow; a pattern of slow ones
      // rests the primary so the next turns do not wait on it.
      noteReachable('primary', primary.name, outcome.ok && outcome.callMs > config.llm.local.slowCallMs);
      if (layerTooSlow('primary')) restLayer('primary', primary.name, 'slow', opts.fn);
      noteServed(outcome.ok ? { fn: opts.fn, layer: 'primary', provider: primary.name } : { fn: opts.fn, layer: 'built-in', provider: 'built-in' });
      return outcome.ok ? outcome.value : null;
    }
    failure = outcome.failure;
    restLayer('primary', primary.name, failure, opts.fn);
    if (failure === 'auth' || failure === 'quota') {
      alertLlmOutage(primary.name, failure, `the local model (${config.llm.local.model}), or the built-in writer when that is unavailable`)
        .catch((err: unknown) => logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Model outage alert failed'));
    }
  }

  const variant = opts.local === 'built-in' || !SPOKEN_FUNCTIONS.has(opts.fn) ? null : opts.local;
  if (variant !== null && budgetEnd - Date.now() >= MIN_LOCAL_ATTEMPT_MS && admitLayer('local', Date.now())) {
    const toSend = localMessages(messages, variant);
    const validate = variant?.validate ?? opts.validate;
    let outcome: Attempt<T> = { ok: false, failure: 'bad_reply' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = budgetEnd - Date.now();
      if (attempt > 0 && remaining < MIN_LOCAL_ATTEMPT_MS) break;
      const timeoutMs = Math.min(config.llm.local.timeoutMs, remaining);
      outcome = await attemptJson(local, toSend, validate, opts, {
        ...shared, timeoutMs, firstTokenMs: Math.min(config.llm.local.firstTokenMs, timeoutMs), responseFormat: 'json',
      });
      // Only a reply that failed the check earns the one retry; an outage does not.
      if (outcome.ok || outcome.failure !== 'bad_reply') break;
    }
    if (outcome.ok) {
      noteReachable('local', local.name);
      if (primary.enabled) recordStepDown('local');
      noteServed({ fn: opts.fn, layer: 'local', provider: local.name });
      return outcome.value;
    }
    if (shouldFailOver(outcome.failure)) restLayer('local', local.name, outcome.failure, opts.fn);
    else noteReachable('local', local.name);
    failure = outcome.failure;
  }

  if (SPOKEN_FUNCTIONS.has(opts.fn)) recordStepDown('built-in');
  noteServed({ fn: opts.fn, layer: 'built-in', provider: 'built-in', ...(failure ? { failure } : {}) });
  return null;
}

export type ServingLayerName = 'primary' | 'local' | 'built-in';

export interface LayerStatus {
  coolingDown: boolean;
  cooldownEndsAt: string | null;
  lastFailureClass: LlmFailureClass | null;
  lastFailureAt: string | null;
}

/** Which layer serves the interviewer right now, and why. No URLs, keys or replies. */
export interface LlmServingStatus {
  layer: ServingLayerName;
  primary: { provider: string; configured: boolean } & LayerStatus;
  local: { enabled: boolean; model: string | null } & LayerStatus;
  stepDowns: { local: number; builtIn: number };
}

function layerStatus(state: LayerState, now: number): LayerStatus {
  const coolingDown = now < state.cooldownUntil;
  return {
    coolingDown,
    cooldownEndsAt: coolingDown ? new Date(state.cooldownUntil).toISOString() : null,
    lastFailureClass: state.lastFailureClass,
    lastFailureAt: state.lastFailureAt === null ? null : new Date(state.lastFailureAt).toISOString(),
  };
}

export function llmServingStatus(now = Date.now()): LlmServingStatus {
  const primary = getLlm();
  const localEnabled = config.llm.local.enabled;
  const { layers, stepDowns } = servingState();
  const primaryStatus = layerStatus(layers.primary, now);
  const localStatus = layerStatus(layers.local, now);
  const layer: ServingLayerName = primary.enabled && !primaryStatus.coolingDown
    ? 'primary'
    : localEnabled && !localStatus.coolingDown ? 'local' : 'built-in';
  return {
    layer,
    primary: { provider: primary.name, configured: primary.enabled, ...primaryStatus },
    local: { enabled: localEnabled, model: localEnabled ? config.llm.local.model : null, ...localStatus },
    stepDowns: { ...stepDowns },
  };
}

/** The slice of the serving status the public /api/health carries. */
export function llmHealthSummary(now = Date.now()): { layer: ServingLayerName; provider: string; localFallback: boolean; coolingDown: boolean; lastFailureClass: LlmFailureClass | null } {
  const s = llmServingStatus(now);
  const provider = s.layer === 'primary' ? s.primary.provider : s.layer === 'local' ? 'ollama' : 'heuristic';
  return { layer: s.layer, provider, localFallback: s.local.enabled, coolingDown: s.primary.coolingDown, lastFailureClass: s.primary.lastFailureClass };
}

/**
 * Pull the JSON value out of a model reply, whatever it wrapped it in.
 *
 * Rewritten after the simulation harness showed every work-sample call failing.
 * The previous version took the first fenced block via `/```(?:json)?\s*(...)/`
 * and returned its contents — but when the fence was tagged `sql` or `python`
 * the optional `json` did not match, `\s*` matched nothing, and the LANGUAGE TAG
 * itself was captured. The result was "sql\nSELECT…", which cannot parse.
 *
 * That hit precisely the generator whose job is to emit an artefact alongside
 * its JSON, so the calls that mattered most were billed, discarded and silently
 * replaced by the heuristic fallback. It also scanned from the first `{` to the
 * LAST `}` in the whole reply, which spans any prose sitting between two
 * objects.
 *
 * Now: try each fenced block, then scan the raw text, and return the first
 * candidate that actually parses. Throws if none does, so `generateJson` falls
 * back for a real reason rather than on a formatting accident.
 */
export function parseJsonLoose(text: string): unknown {
  if (!text) throw new Error('empty model reply');

  for (const block of fencedBlocks(text)) {
    const parsed = firstBalancedValue(block);
    if (parsed !== undefined) return parsed;
  }
  const parsed = firstBalancedValue(text);
  if (parsed !== undefined) return parsed;

  throw new Error(`no JSON value found in model reply (started "${text.slice(0, 120)}")`);
}

/** Fenced block bodies, with the language tag left behind where it belongs. */
function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** First `{`/`[` that opens a balanced, parseable value. `undefined` if none. */
function firstBalancedValue(text: string): unknown {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = matchingClose(text, i);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {
      // Balanced but not valid JSON — keep scanning rather than giving up.
    }
  }
  return undefined;
}

/** Index of the brace closing the one at `start`, or -1. String-aware. */
function matchingClose(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export async function logModelExecution(row: {
  sessionId: string;
  provider: string;
  model: string;
  fn: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  promptRef?: string;
  params?: unknown;
  safety?: unknown;
}): Promise<string> {
  try {
    const rec = await prisma.modelExecution.create({
      data: {
        sessionId: row.sessionId,
        provider: row.provider,
        model: row.model,
        function: row.fn,
        promptRef: row.promptRef ?? '',
        paramsJson: JSON.stringify(row.params ?? {}),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        latencyMs: row.latencyMs,
        safetyJson: JSON.stringify(row.safety ?? {}),
      },
    });
    return rec.id;
  } catch {
    return '';
  }
}
