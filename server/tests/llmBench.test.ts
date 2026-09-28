import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM script, no type declarations
import { parseBenchArgs, benchOnce, summariseRuns, BENCH_PROMPTS, DEFAULT_BENCH_MODELS } from '../scripts/llm-bench.mjs';

/**
 * The Phase 0 benchmark the owner runs on the VPS: time-to-first-token and
 * tokens per second for each candidate model on realistic interviewer prompts.
 * Tested against a fake streaming Ollama, never a real one.
 */

const NS = 1e9;

function ndjsonResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(`${JSON.stringify(c)}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function fakeOllama(text = '{"acknowledgement":"You rebuilt the tracker.","question":"What made you choose that approach?"}') {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const half = Math.floor(text.length / 2);
    return ndjsonResponse([
      { message: { content: text.slice(0, half) }, done: false },
      { message: { content: text.slice(half) }, done: false },
      { message: { content: '' }, done: true, done_reason: 'stop', eval_count: 20, eval_duration: 2 * NS, prompt_eval_count: 300, prompt_eval_duration: 3 * NS, load_duration: 0.5 * NS },
    ]);
  };
  return { fetchImpl, calls };
}

function clock(ticks: number[]) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

describe('parseBenchArgs', () => {
  it('defaults to loopback Ollama and the two licensed candidates', () => {
    expect(parseBenchArgs([])).toMatchObject({ url: 'http://127.0.0.1:11434', models: DEFAULT_BENCH_MODELS, runs: 2 });
  });

  it('benchmarks llama3.2:3b and phi4-mini by default', () => {
    expect(DEFAULT_BENCH_MODELS).toEqual(['llama3.2:3b', 'phi4-mini']);
  });

  it('reads the URL, models and runs', () => {
    expect(parseBenchArgs(['--url', 'http://10.0.0.5:11434/', '--models', 'a,b', '--runs', '3']))
      .toMatchObject({ url: 'http://10.0.0.5:11434', models: ['a', 'b'], runs: 3 });
  });

  it('refuses a run count that is not a positive whole number', () => {
    expect(() => parseBenchArgs(['--runs', '0'])).toThrow(/runs/);
  });
});

describe('BENCH_PROMPTS', () => {
  it('covers the three spoken jobs the local model is trusted with', () => {
    expect(BENCH_PROMPTS.map((p: { id: string }) => p.id)).toEqual(['acknowledge', 'choose_probe', 'answer_question']);
  });

  it('uses the full interviewer persona prompt, so prompt reading is timed at its real length', () => {
    expect(BENCH_PROMPTS[0].system.split(/\s+/).length).toBeGreaterThan(400);
  });
});

describe('benchOnce', () => {
  it('streams from /api/chat with JSON output, as the app does', async () => {
    const { fetchImpl, calls } = fakeOllama();
    await benchOnce({ url: 'http://x:11434', model: 'llama3.2:3b', prompt: BENCH_PROMPTS[0], fetchImpl, now: clock([0, 400, 500, 2500]) });
    expect([calls[0].url, calls[0].body.stream, calls[0].body.format]).toEqual(['http://x:11434/api/chat', true, 'json']);
  });

  it('measures time to first token from the first non-empty chunk', async () => {
    const { fetchImpl } = fakeOllama();
    const r = await benchOnce({ url: 'http://x', model: 'm', prompt: BENCH_PROMPTS[0], fetchImpl, now: clock([1000, 1400, 1500, 3000]) });
    expect(r.ttftMs).toBe(400);
  });

  it('takes generation speed from Ollama\'s own counters', async () => {
    const { fetchImpl } = fakeOllama();
    const r = await benchOnce({ url: 'http://x', model: 'm', prompt: BENCH_PROMPTS[0], fetchImpl, now: clock([0, 1, 2, 3]) });
    expect([r.tokensPerSec, r.promptTokensPerSec]).toEqual([10, 100]);
  });

  it('keeps the whole reply for the owner to judge', async () => {
    const { fetchImpl } = fakeOllama('{"intent":"answer","confidence":0.9}');
    const r = await benchOnce({ url: 'http://x', model: 'm', prompt: BENCH_PROMPTS[1], fetchImpl, now: clock([0, 1, 2, 3]) });
    expect(r.text).toBe('{"intent":"answer","confidence":0.9}');
  });

  it('reports whether the reply parsed as JSON', async () => {
    const { fetchImpl } = fakeOllama('not json');
    const r = await benchOnce({ url: 'http://x', model: 'm', prompt: BENCH_PROMPTS[1], fetchImpl, now: clock([0, 1, 2, 3]) });
    expect(r.validJson).toBe(false);
  });

  it('fails with the status when Ollama refuses (e.g. model not pulled)', async () => {
    const fetchImpl = async () => new Response('{"error":"model not found"}', { status: 404 });
    await expect(benchOnce({ url: 'http://x', model: 'nope', prompt: BENCH_PROMPTS[0], fetchImpl, now: Date.now })).rejects.toThrow(/404/);
  });
});

describe('summariseRuns', () => {
  it('reports median time to first token and mean tokens per second', () => {
    const runs = [
      { ttftMs: 1000, totalMs: 3000, tokensPerSec: 10, promptTokensPerSec: 100, words: 20, validJson: true },
      { ttftMs: 3000, totalMs: 5000, tokensPerSec: 14, promptTokensPerSec: 120, words: 22, validJson: true },
      { ttftMs: 2000, totalMs: 4000, tokensPerSec: 12, promptTokensPerSec: 110, words: 24, validJson: false },
    ];
    expect(summariseRuns(runs)).toMatchObject({ medianTtftMs: 2000, meanTokensPerSec: 12, jsonOk: '2/3' });
  });
});
