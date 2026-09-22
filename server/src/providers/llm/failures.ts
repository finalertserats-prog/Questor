import { LlmApiError, LlmStreamError } from './types.js';

/**
 * Why a model call failed, in the terms the failover chain acts on. Recorded
 * on the ModelExecution row and shown on the health page; never the provider's
 * reply itself, which can quote part of a key.
 */
export type LlmFailureClass =
  | 'auth'        // 401/403: the key is wrong, revoked or not allowed
  | 'quota'       // 429 insufficient_quota: the account has no credit
  | 'rate_limit'  // 429 otherwise: too many requests right now
  | 'server'      // 5xx or 408: the provider is having a bad time
  | 'timeout'     // no answer before the deadline
  | 'network'     // no connection at all
  | 'interrupted' // a streamed reply stopped part-way
  | 'slow'        // answering, but too slowly to hold a conversation (set by the chain, not by an error)
  | 'bad_request' // other 4xx: we built the request wrong
  | 'bad_reply';  // the model answered, but not with something usable

/** How long a failing provider is left alone before one probe brings it back. */
export type CooldownKind = 'long' | 'short' | 'none';

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function causeCode(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') return cause.code;
  const own = (err as { code?: unknown }).code;
  return typeof own === 'string' ? own : '';
}

export function classifyLlmFailure(err: unknown): LlmFailureClass {
  if (err instanceof LlmApiError) {
    if (err.status === 401 || err.status === 403) return 'auth';
    if (err.insufficientQuota) return 'quota';
    if (err.status === 429) return 'rate_limit';
    if (err.status >= 500 || err.status === 408) return 'server';
    return 'bad_request';
  }
  if (err instanceof LlmStreamError) return 'interrupted';
  if (!(err instanceof Error)) return 'bad_reply';
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || /^model call exceeded \d+ms$/.test(err.message)) return 'timeout';
  const code = causeCode(err);
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (NETWORK_CODES.has(code) || (err instanceof TypeError && err.message === 'fetch failed')) return 'network';
  // Everything else is the reply itself: truncated, empty, not JSON, wrong shape.
  return 'bad_reply';
}

/**
 * Only a failure another provider could avoid moves the request down the
 * chain. A request we built wrong, or a reply that did not fit, would fail the
 * same way on the next model, so it goes to the built-in writer as it always has.
 */
export function shouldFailOver(cls: LlmFailureClass): boolean {
  return cooldownKindFor(cls) !== 'none';
}

export function cooldownKindFor(cls: LlmFailureClass): CooldownKind {
  switch (cls) {
    case 'auth':
    case 'quota':
      return 'long';
    case 'rate_limit':
    case 'server':
    case 'timeout':
    case 'network':
    case 'interrupted':
    case 'slow':
      return 'short';
    case 'bad_request':
    case 'bad_reply':
      return 'none';
    default: {
      const unreachable: never = cls;
      return unreachable;
    }
  }
}
