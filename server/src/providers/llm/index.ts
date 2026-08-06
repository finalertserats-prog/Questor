import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { logger } from '../../logger.js';
import type { LlmProvider, LlmMessage } from './types.js';
import { HeuristicLlmProvider } from './heuristic.js';
import { AnthropicLlmProvider } from './anthropic.js';
import { OpenAiLlmProvider } from './openai.js';

export type { LlmProvider, LlmMessage } from './types.js';

let cached: LlmProvider | null = null;

export function getLlm(): LlmProvider {
  if (cached) return cached;
  const p = config.llm.provider;
  if (p === 'anthropic' && config.llm.anthropicKey) {
    cached = new AnthropicLlmProvider(config.llm.anthropicKey, config.llm.anthropicModel);
  } else if (p === 'openai' && config.llm.openaiKey) {
    cached = new OpenAiLlmProvider(config.llm.openaiKey, config.llm.openaiModel);
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

/**
 * Ask the configured LLM for JSON, validate it, and log a ModelExecution row.
 * Returns null (never throws) so callers can fall back to their heuristic path.
 */
export async function generateJson<T>(opts: {
  fn: string; // ModelExecution.function
  system: string;
  user: string;
  validate: (raw: unknown) => T;
  sessionId?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<T | null> {
  const llm = getLlm();
  if (!llm.enabled) return null;
  const messages: LlmMessage[] = [
    { role: 'system', content: opts.system + '\n\nRespond ONLY with valid minified JSON. No prose, no code fences.' },
    { role: 'user', content: opts.user },
  ];
  try {
    const result = await llm.generate(messages, { temperature: opts.temperature ?? 0.3, maxTokens: opts.maxTokens });
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
