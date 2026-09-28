import { LlmApiError, LlmStreamError, PROVIDER_HARD_TIMEOUT_MS, type LlmGenerateOptions, type LlmMessage, type LlmProvider, type LlmResult } from './types.js';

/**
 * The reply budget when a caller does not set one. Smaller than the hosted
 * adapters': the local model only writes conversational glue, and on a CPU
 * every token is roughly a tenth of a second the candidate waits.
 */
const DEFAULT_MAX_TOKENS = 400;

interface ChatChunk {
  message?: { content?: unknown };
  done?: unknown;
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  error?: unknown;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function timeoutError(message: string): Error {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

/** The /api/chat request body. Pure, so the shape is tested without a network. */
export function ollamaRequestBody(
  model: string,
  messages: LlmMessage[],
  opts: LlmGenerateOptions | undefined,
  keepAlive: string,
): Record<string, unknown> {
  return {
    model,
    messages,
    // Streamed so a model that has not started answering within the
    // first-token budget is abandoned rather than waited on in silence.
    stream: true,
    // Constrained JSON keeps a 3B model on shape; without it small models wrap
    // the object in prose often enough to lose the turn.
    ...(opts?.responseFormat === 'json' ? { format: 'json' } : {}),
    // A cold load from disk costs seconds on this CPU; keep the model resident.
    keep_alive: keepAlive,
    options: {
      num_predict: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature ?? 0.4,
    },
  };
}

/** Parse NDJSON lines as they arrive; `onChunk` sees each object in order. */
async function readNdjson(body: ReadableStream<Uint8Array>, onChunk: (chunk: ChatChunk) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) onChunk(parseChunk(line));
      newline = buffered.indexOf('\n');
    }
  }
  const tail = buffered.trim();
  if (tail) onChunk(parseChunk(tail));
}

/** A line that is not JSON means the stream broke mid-object, not that the model replied badly. */
function parseChunk(line: string): ChatChunk {
  try {
    return JSON.parse(line) as ChatChunk;
  } catch {
    throw new LlmStreamError('Ollama stream sent a malformed line');
  }
}

/**
 * Ollama on the VPS: the local fallback when the hosted model is unavailable.
 * No key: it listens on loopback only (see docs/RUNBOOK.md).
 */
export class OllamaLlmProvider implements LlmProvider {
  name = 'ollama';
  enabled = true;
  private readonly baseUrl: string;

  constructor(baseUrl: string, private model: string, private keepAlive = '24h') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult> {
    const started = Date.now();
    const abort = new AbortController();
    let reason: Error | null = null;
    const stop = (err: Error) => {
      if (reason) return;
      reason = err;
      abort.abort(err);
    };
    // Never unbounded: a stream that never finishes holds the turn open.
    const totalMs = opts?.timeoutMs ?? PROVIDER_HARD_TIMEOUT_MS;
    const totalTimer = setTimeout(() => stop(timeoutError(`Ollama reply not finished within ${totalMs}ms`)), totalMs);
    let firstTokenTimer = opts?.firstTokenMs
      ? setTimeout(() => stop(timeoutError(`Ollama sent no token within ${opts.firstTokenMs}ms`)), opts.firstTokenMs)
      : undefined;
    const clearFirstToken = () => {
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      firstTokenTimer = undefined;
    };

    let text = '';
    let finished: ChatChunk | null = null;
    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: abort.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ollamaRequestBody(this.model, messages, opts, this.keepAlive)),
      });
      if (!res.ok) throw new LlmApiError('Ollama', res.status, await res.text());
      if (!res.body) throw new LlmStreamError('Ollama answered with no body');
      await readNdjson(res.body, (chunk) => {
        if (typeof chunk.error === 'string') throw new LlmStreamError(`Ollama stream error: ${chunk.error}`);
        const piece = typeof chunk.message?.content === 'string' ? chunk.message.content : '';
        if (piece) {
          clearFirstToken();
          text += piece;
        }
        if (chunk.done === true) finished = chunk;
      });
    } catch (err) {
      // An abort surfaces as a generic AbortError; report why we aborted.
      throw reason ?? err;
    } finally {
      clearFirstToken();
      if (totalTimer) clearTimeout(totalTimer);
    }
    if (reason) throw reason;

    const done = finished as ChatChunk | null;
    if (!done) throw new LlmStreamError('Ollama stream ended before the reply was done');
    // Same rule as the hosted adapters: a cut-off reply is a failure, not a
    // shorter answer, because callers parse it as JSON or speak it aloud.
    if (done.done_reason === 'length') throw new Error('Ollama reply truncated (done_reason length)');
    if (!text.trim()) throw new Error('Ollama returned an empty reply');
    return {
      text,
      model: this.model,
      inputTokens: count(done.prompt_eval_count),
      outputTokens: count(done.eval_count),
      latencyMs: Date.now() - started,
    };
  }
}
