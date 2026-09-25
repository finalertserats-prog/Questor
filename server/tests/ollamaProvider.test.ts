import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaLlmProvider, ollamaRequestBody } from '../src/providers/llm/ollama.js';
import { LlmApiError, LlmStreamError } from '../src/providers/llm/types.js';

/**
 * The local fallback talks to Ollama's HTTP API on the VPS. It must look like
 * every other adapter to its callers: same interface, same "a cut-off or empty
 * reply is a failure" rule, same LlmApiError on an HTTP refusal. It streams so
 * a model that has not started answering within the first-token budget is
 * abandoned instead of leaving the candidate in silence.
 */

const BASE = 'http://127.0.0.1:11434';
const msgs = [
  { role: 'system' as const, content: 'You are the interviewer.' },
  { role: 'user' as const, content: 'Candidate said: I ran the tracker.' },
];

const encoder = new TextEncoder();

function doneChunk(extra: Record<string, unknown> = {}) {
  return { message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 42, eval_count: 17, ...extra };
}

/** An NDJSON stream; `gapMs` delays every chunk after the first `immediate` ones. */
function ndjson(chunks: unknown[], opts: { gapMs?: number; immediate?: number } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [i, c] of chunks.entries()) {
        if (opts.gapMs && i >= (opts.immediate ?? 0)) await new Promise((r) => setTimeout(r, opts.gapMs));
        controller.enqueue(encoder.encode(`${JSON.stringify(c)}\n`));
      }
      controller.close();
    },
  });
}

function stubStream(chunks: unknown[], opts: { gapMs?: number; immediate?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(ndjson(chunks, opts), { status: 200 });
  }));
  return calls;
}

function stubStatus(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

const reply = (text: string) => [{ message: { content: text.slice(0, 5) }, done: false }, { message: { content: text.slice(5) }, done: false }, doneChunk()];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ollamaRequestBody', () => {
  it('sends the conversation unchanged, streamed, to the configured model', () => {
    const body = ollamaRequestBody('llama3.2:3b', msgs, undefined, '30m');
    expect(body).toMatchObject({ model: 'llama3.2:3b', messages: msgs, stream: true, keep_alive: '30m' });
  });

  it('maps maxTokens and temperature to Ollama options', () => {
    const body = ollamaRequestBody('m', msgs, { maxTokens: 60, temperature: 0 }, '30m');
    expect(body.options).toEqual({ num_predict: 60, temperature: 0 });
  });

  it('asks for JSON output when the caller expects JSON', () => {
    const body = ollamaRequestBody('m', msgs, { responseFormat: 'json' }, '30m');
    expect(body.format).toBe('json');
  });

  it('leaves the output format free when the caller does not ask for JSON', () => {
    expect(ollamaRequestBody('m', msgs, undefined, '30m')).not.toHaveProperty('format');
  });
});

describe('OllamaLlmProvider', () => {
  it('posts to /api/chat on the configured base URL', async () => {
    const calls = stubStream(reply('{"intent":"answer"}'));
    await new OllamaLlmProvider(`${BASE}/`, 'llama3.2:3b').generate(msgs);
    expect(calls[0].url).toBe(`${BASE}/api/chat`);
  });

  it('joins the streamed reply and reports token counts', async () => {
    stubStream(reply('{"intent":"answer"}'));
    const result = await new OllamaLlmProvider(BASE, 'llama3.2:3b').generate(msgs);
    expect(result).toMatchObject({ text: '{"intent":"answer"}', model: 'llama3.2:3b', inputTokens: 42, outputTokens: 17 });
  });

  it('names itself ollama and reports enabled', () => {
    const p = new OllamaLlmProvider(BASE, 'm');
    expect([p.name, p.enabled]).toEqual(['ollama', true]);
  });

  it('throws LlmApiError with the status when Ollama refuses', async () => {
    stubStatus(404, { error: 'model "nope" not found, try pulling it first' });
    await expect(new OllamaLlmProvider(BASE, 'nope').generate(msgs)).rejects.toBeInstanceOf(LlmApiError);
  });

  it('treats a reply cut off at the token limit as a failure', async () => {
    stubStream([{ message: { content: '{"intent":' }, done: false }, doneChunk({ done_reason: 'length' })]);
    await expect(new OllamaLlmProvider(BASE, 'm').generate(msgs)).rejects.toThrow(/truncated/);
  });

  it('treats an empty reply as a failure', async () => {
    stubStream([doneChunk()]);
    await expect(new OllamaLlmProvider(BASE, 'm').generate(msgs)).rejects.toThrow(/empty/);
  });

  it('treats a stream that ends before "done" as interrupted', async () => {
    stubStream([{ message: { content: '{"ack' }, done: false }]);
    await expect(new OllamaLlmProvider(BASE, 'm').generate(msgs)).rejects.toBeInstanceOf(LlmStreamError);
  });

  it('reports a malformed line as an interrupted stream, not a bad reply', async () => {
    const encoder2 = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(encoder2.encode('{"message":{"content":"x"}\n{"mess')); c.close(); },
    }), { status: 200 })));
    await expect(new OllamaLlmProvider(BASE, 'm').generate(msgs)).rejects.toBeInstanceOf(LlmStreamError);
  });

  it('reports an error chunk inside the stream as interrupted', async () => {
    stubStream([{ error: 'model runner has unexpectedly stopped' }]);
    await expect(new OllamaLlmProvider(BASE, 'm').generate(msgs)).rejects.toBeInstanceOf(LlmStreamError);
  });

  it('gives up when the first token does not arrive within the first-token budget', async () => {
    stubStream(reply('{"a":1}'), { gapMs: 200 });
    await expect(new OllamaLlmProvider(BASE, 'm').generate(msgs, { timeoutMs: 5_000, firstTokenMs: 30 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('gives up when the whole reply overruns the total budget', async () => {
    stubStream(reply('{"a":1}'), { gapMs: 60, immediate: 1 });
    await expect(new OllamaLlmProvider(BASE, 'm').generate(msgs, { timeoutMs: 80, firstTokenMs: 1_000 })).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('sends no credentials of any kind', async () => {
    const calls = stubStream(reply('x-y-z'));
    await new OllamaLlmProvider(BASE, 'm').generate(msgs);
    expect(Object.keys(calls[0].init.headers as Record<string, string>)).toEqual(['content-type']);
  });
});
