import type { LlmFailureClass } from './failures.js';

/**
 * Short failure memory for the failover chain, per layer and per process.
 *
 * After a failure the layer is skipped until its cooldown ends, so the turns
 * that follow do not each wait out the same failure. When it ends, exactly one
 * request is let through as a probe; everyone else keeps skipping until that
 * probe answers. Success clears the memory. Failure starts a new cooldown,
 * twice as long as the last (up to a ceiling), so a provider that keeps failing
 * is probed less and less often rather than stormed.
 */

export type ServingLayer = 'primary' | 'local';

export interface LayerState {
  readonly cooldownUntil: number;
  readonly lastFailureClass: LlmFailureClass | null;
  readonly lastFailureAt: number | null;
  readonly probing: boolean;
  /** Failures since the layer last answered; drives the backoff. */
  readonly failureStreak: number;
  /** Slow answers in a row; two make a 'slow' failure. */
  readonly slowStreak: number;
}

export interface StepDowns {
  readonly local: number;
  readonly builtIn: number;
}

/** Slow answers in a row before the layer is rested. One slow turn is noise; two is a pattern. */
export const SLOW_ANSWERS_BEFORE_REST = 2;

const FRESH: LayerState = { cooldownUntil: 0, lastFailureClass: null, lastFailureAt: null, probing: false, failureStreak: 0, slowStreak: 0 };

let layers: Readonly<Record<ServingLayer, LayerState>> = { primary: FRESH, local: FRESH };
let stepDowns: StepDowns = { local: 0, builtIn: 0 };

function update(layer: ServingLayer, next: LayerState): void {
  layers = { ...layers, [layer]: next };
}

/** May this request use the layer? Claims the probe when a cooldown has just ended. */
export function admitLayer(layer: ServingLayer, now: number): boolean {
  const state = layers[layer];
  if (state.cooldownUntil === 0) return true;
  if (now < state.cooldownUntil || state.probing) return false;
  update(layer, { ...state, probing: true });
  return true;
}

/**
 * Rest the layer: `baseMs` the first time, doubling with every failure since it
 * last answered, never past `maxMs`. Returns the rest actually applied.
 */
export function recordLayerFailure(layer: ServingLayer, cls: LlmFailureClass, now: number, baseMs: number, maxMs: number): number {
  const streak = layers[layer].failureStreak + 1;
  const restMs = Math.min(baseMs * 2 ** (streak - 1), Math.max(maxMs, baseMs));
  update(layer, { cooldownUntil: now + restMs, lastFailureClass: cls, lastFailureAt: now, probing: false, failureStreak: streak, slowStreak: 0 });
  return restMs;
}

/**
 * Note a failure for REPORTING only: no cooldown, no backoff, nothing skipped.
 *
 * What the flag-off path needs. There is no chain there to rest a layer, and
 * resting one would change behaviour rather than only what is visible — but
 * the admin health view still has to be able to say what went wrong
 * (docs/qa/resilience-2026-09-23.md, R2).
 */
export function noteLayerFailureForReport(layer: ServingLayer, cls: LlmFailureClass, now: number): void {
  update(layer, { ...layers[layer], lastFailureClass: cls, lastFailureAt: now });
}

/**
 * The layer answered (even with a reply we could not use: it is reachable).
 * True when this ends an outage, so the caller can log the recovery.
 */
export function recordLayerReachable(layer: ServingLayer, slow = false): boolean {
  const state = layers[layer];
  const recovered = state.cooldownUntil !== 0;
  update(layer, {
    ...FRESH,
    lastFailureClass: state.lastFailureClass,
    lastFailureAt: state.lastFailureAt,
    slowStreak: slow ? state.slowStreak + 1 : 0,
  });
  return recovered;
}

/** Whether the layer has now been slow often enough in a row to be rested. */
export function layerTooSlow(layer: ServingLayer): boolean {
  return layers[layer].slowStreak >= SLOW_ANSWERS_BEFORE_REST;
}

export function recordStepDown(to: 'local' | 'built-in'): void {
  stepDowns = to === 'local' ? { ...stepDowns, local: stepDowns.local + 1 } : { ...stepDowns, builtIn: stepDowns.builtIn + 1 };
}

export function servingState(): { readonly layers: Readonly<Record<ServingLayer, LayerState>>; readonly stepDowns: StepDowns } {
  return { layers, stepDowns };
}

/**
 * What actually served the last model call, and why it was not the primary.
 *
 * The cooldowns above are the failover chain's memory, and with
 * LOCAL_LLM_ENABLED off there is no chain — so nothing rested the primary and
 * `/api/health` reported `llm.layer: "primary"` straight through a total
 * outage (docs/qa/resilience-2026-09-23.md, R2). This is the other half of the
 * answer: not "which layer would we use", but "which layer did we just use".
 *
 * Kept separate on purpose. It records; it never skips a layer, never rests
 * one, and never changes which provider a call reaches — so the flag-off path
 * still tries the primary on every single turn, exactly as it did.
 */
export interface RecentServing {
  readonly layer: 'primary' | 'local' | 'built-in';
  readonly at: number;
  readonly failure: LlmFailureClass | null;
}

/**
 * How long the last outcome is still worth reporting. Long enough that an
 * uptime check between interviews still sees an outage, short enough that a
 * recovered provider stops being described as down.
 */
export const SERVING_RECENCY_MS = 5 * 60_000;

let lastServed: RecentServing | null = null;

export function recordServedLayer(layer: RecentServing['layer'], at: number, failure: LlmFailureClass | null): void {
  lastServed = { layer, at, failure };
}

/** The last outcome, while it is still recent. */
export function recentServing(now: number): RecentServing | null {
  if (!lastServed || now - lastServed.at > SERVING_RECENCY_MS) return null;
  return lastServed;
}

/** Test hook: forget every failure and count. */
export function _resetServingState(): void {
  layers = { primary: FRESH, local: FRESH };
  stepDowns = { local: 0, builtIn: 0 };
  lastServed = null;
}
