import { AsyncLocalStorage } from 'node:async_hooks';
import type { LlmFailureClass } from './failures.js';

/**
 * Which model layer served each conversational call made while composing one
 * interviewer turn. The interview engine wraps a turn in `traceServing` and
 * stores the result on the turn, so a reviewer can see which turns ran on the
 * local model or the built-in writer and not judge the candidate as if every
 * probe had been full quality.
 */

export interface ServedCall {
  readonly fn: string;
  readonly layer: 'primary' | 'local' | 'built-in';
  readonly provider: string;
  /** Why the call ended below the primary, when an outage was the reason. */
  readonly failure?: LlmFailureClass;
}

interface TraceStore {
  served: readonly ServedCall[];
}

const trace = new AsyncLocalStorage<TraceStore>();

export async function traceServing<T>(work: () => Promise<T>): Promise<{ result: T; served: readonly ServedCall[] }> {
  const store: TraceStore = { served: [] };
  const result = await trace.run(store, work);
  return { result, served: store.served };
}

/** Called by the failover chain; a no-op outside a traced turn. */
export function noteServed(call: ServedCall): void {
  const store = trace.getStore();
  if (store) store.served = [...store.served, call];
}
