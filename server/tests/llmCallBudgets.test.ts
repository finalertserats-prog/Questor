import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmMessage, LlmProvider, LlmResult } from '../src/providers/llm/types.js';

/**
 * R1: a model call with no timeout hangs the candidate's request.
 *
 * `work_sample` runs inside a live turn and was observed open for 212 s with
 * no reply and no timeout (docs/qa/resilience-2026-09-23.md §1.2). Eight of
 * eleven call sites passed no `timeoutMs` at all, so the only bound was
 * undici's 300 s default — nothing Questor chose.
 *
 * The fix is by construction: every call site names a PURPOSE, the purpose
 * carries the budget, and the type makes a call site without one impossible.
 * These tests hold that shut from three sides:
 *
 *  1. every `generateJson` call site in src/ names a known purpose (scanned
 *     out of the source, so a new call site is covered the day it is written);
 *  2. every one of those call sites, driven with a provider that never
 *     answers, ends within its own budget;
 *  3. the provider adapters bound the socket even when a caller passes no
 *     options at all, so a direct `provider.generate` cannot hang either.
 */

// Short budgets so the per-call-site sweep below costs seconds, not minutes.
// The shipped defaults are asserted from the exported constants instead.
process.env.LLM_LIVE_TURN_TIMEOUT_MS = '1500';
process.env.LLM_AUTHORING_TIMEOUT_MS = '2000';
process.env.LLM_FINALISATION_TIMEOUT_MS = '2500';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

interface CallSite {
  readonly file: string;
  readonly fn: string;
  readonly purpose: string;
}

function closingBrace(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Every `generateJson` call site in src/, with the `fn` and `purpose` it names. */
function callSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of tsFiles(SRC)) {
    if (file.endsWith(path.join('providers', 'llm', 'index.ts'))) continue;
    const text = readFileSync(file, 'utf8');
    // Lazy and newline-bounded rather than `[^>]*`: a type argument may itself
    // be generic (`<Partial<RoleSuccessProfile> & { title?: string }>`) or hold
    // a semicolon (`<{ title: string; text: string }>`), and either silently
    // skipped that call site. The count guard below catches it if it does.
    const re = /generateJson\s*(?:<[^\n]*?>)?\s*\(\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // The `{` the regex ended on — not the first `{` after `generateJson`,
      // which for `generateJson<{ prompt: string }>({` is the type argument.
      const open = m.index + m[0].length - 1;
      const body = text.slice(open, closingBrace(text, open) + 1);
      const fn = /\bfn:\s*'([^']+)'/.exec(body)?.[1] ?? '(unnamed)';
      const purpose = /\bpurpose:\s*'([^']+)'/.exec(body)?.[1] ?? '(none)';
      sites.push({ file: path.relative(SRC, file).replace(/\\/g, '/'), fn, purpose });
    }
  }
  return sites;
}

const SITES = callSites();

/** Never answers, never rejects: the `hang` mode the resilience harness drove. */
class HangingProvider implements LlmProvider {
  name = 'openai';
  enabled = true;
  calls = 0;
  async generate(_messages: LlmMessage[]): Promise<LlmResult> {
    this.calls++;
    return new Promise<LlmResult>(() => {});
  }
}

const {
  config, LLM_PURPOSES,
  DEFAULT_LLM_LIVE_TURN_TIMEOUT_MS, DEFAULT_LLM_AUTHORING_TIMEOUT_MS, DEFAULT_LLM_FINALISATION_TIMEOUT_MS,
} = await import('../src/config.js');
const { generateJson, _setLlmForTests } = await import('../src/providers/llm/index.js');
const { OpenAiLlmProvider } = await import('../src/providers/llm/openai.js');
const { AnthropicLlmProvider } = await import('../src/providers/llm/anthropic.js');

let hanging: HangingProvider;

beforeEach(() => {
  hanging = new HangingProvider();
  _setLlmForTests(hanging);
});

afterEach(() => {
  _setLlmForTests(null);
  vi.unstubAllGlobals();
});

describe('every model call carries a budget', () => {
  it('finds every call site (guards the scan itself)', () => {
    // A scan that silently misses a call site proves nothing, so it is checked
    // against a plain count of the calls in the source.
    const written = tsFiles(SRC)
      .filter((f) => !f.endsWith(path.join('providers', 'llm', 'index.ts')))
      .reduce((n, f) => n + (readFileSync(f, 'utf8').match(/\bgenerateJson\s*[<(]/g)?.length ?? 0), 0);
    expect(SITES.length).toBe(written);
    expect(SITES.length).toBeGreaterThanOrEqual(11);
  });

  it('names every call site (guards the scan itself)', () => {
    expect(SITES.filter((s) => s.fn === '(unnamed)')).toEqual([]);
  });

  it('names a purpose at every call site', () => {
    const missing = SITES.filter((s) => s.purpose === '(none)');
    expect(missing.map((s) => `${s.file}:${s.fn}`)).toEqual([]);
  });

  it('names a purpose the config knows a budget for', () => {
    const unknown = SITES.filter((s) => !(LLM_PURPOSES as readonly string[]).includes(s.purpose));
    expect(unknown.map((s) => `${s.file}:${s.fn}=${s.purpose}`)).toEqual([]);
  });

  it('gives every call made inside a live turn the live-turn budget', () => {
    const live = SITES.filter((s) => ['live_interviewer', 'candidate_question', 'candidate_intent', 'work_sample'].includes(s.fn));
    expect(live.map((s) => s.fn).sort()).toEqual(['candidate_intent', 'candidate_question', 'live_interviewer', 'work_sample']);
    expect(live.every((s) => s.purpose === 'live_turn')).toBe(true);
  });

  it('fails fast enough on a live turn to fall back inside the turn budget', () => {
    expect(DEFAULT_LLM_LIVE_TURN_TIMEOUT_MS).toBeLessThanOrEqual(config.llm.interviewerTimeoutMs);
  });

  it('is more patient with finalisation than with a live turn', () => {
    expect(DEFAULT_LLM_FINALISATION_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LLM_AUTHORING_TIMEOUT_MS);
    expect(DEFAULT_LLM_AUTHORING_TIMEOUT_MS).toBeGreaterThan(DEFAULT_LLM_LIVE_TURN_TIMEOUT_MS);
  });
});

// One case per call site: the real `fn` and the real `purpose` the source
// declares, against a provider that never answers.
describe.each(SITES.map((s) => [`${s.file} ${s.fn}`, s] as const))('%s', (_label, site) => {
  it('ends on the built-in path within its own budget', async () => {
    const budget = config.llm.budgets[site.purpose as keyof typeof config.llm.budgets];
    const began = Date.now();
    const result = await generateJson<unknown>({
      fn: site.fn,
      purpose: site.purpose as 'live_turn',
      system: 's',
      user: 'u',
      validate: (raw) => raw,
    });
    const elapsed = Date.now() - began;
    expect(result).toBeNull();
    expect(hanging.calls).toBe(1);
    // The deadline fires, and it fires at the budget, not at the HTTP client's
    // 300 s default.
    expect(elapsed).toBeGreaterThanOrEqual(budget - 250);
    expect(elapsed).toBeLessThan(budget + 5_000);
  }, 30_000);
});

describe('the provider adapters bound the socket themselves', () => {
  function captureFetch(body: unknown) {
    const inits: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { inits.push(init); return new Response(JSON.stringify(body)); }));
    return inits;
  }

  it('bounds an OpenAI call a caller passed no options for', async () => {
    const inits = captureFetch({ choices: [{ message: { content: '[]' } }], usage: {} });
    await new OpenAiLlmProvider('k', 'm').generate([{ role: 'user', content: 'x' }]);
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds an Anthropic call a caller passed no options for', async () => {
    const inits = captureFetch({ content: [{ type: 'text', text: '[]' }], usage: {} });
    await new AnthropicLlmProvider('k', 'm').generate([{ role: 'user', content: 'x' }]);
    expect(inits[0].signal).toBeInstanceOf(AbortSignal);
  });
});
