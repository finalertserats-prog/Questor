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
    const jsonText = extractJson(result.text);
    const parsed = JSON.parse(jsonText);
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

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const s = arrStart >= 0 && (arrStart < start || start < 0) ? arrStart : start;
  if (s < 0) return text.trim();
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  return text.slice(s, end + 1);
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
