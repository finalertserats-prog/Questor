import type { LlmGenerateOptions, LlmMessage, LlmProvider, LlmResult, ReasoningEffort } from './types.js';

/** The reply budget when a caller does not set one. */
const DEFAULT_MAX_TOKENS = 1500;

/**
 * Reasoning tokens are spent out of the same budget as the reply. A budget
 * sized for the reply alone can be used up entirely by thinking, and the model
 * then returns an empty message with finish_reason "length". So a reasoning
 * model gets this much on top of whatever the caller asked for.
 */
const REASONING_ALLOWANCE_TOKENS = 2000;

/**
 * Models that reason before replying: the gpt-5 family and the o-series.
 *
 * They take a different request shape from the chat models before them. Sent
 * `max_tokens`, gpt-5.6-sol answers 400 "Unsupported parameter: 'max_tokens'
 * … Use 'max_completion_tokens' instead" (verified live 2026-09-19), and they
 * do not accept a sampling temperature. Matched by prefix, so a new dated or
 * suffixed release of the same family is covered without a code change.
 */
export function isReasoningModel(model: string): boolean {
  return /^(?:gpt-5|o1|o3|o4)(?:$|[-.])/i.test(model.trim());
}

/** The Chat Completions request body for this model. Pure, so the shape is tested without a network. */
export function openAiRequestBody(
  model: string,
  messages: LlmMessage[],
  opts: LlmGenerateOptions | undefined,
  defaultEffort: ReasoningEffort,
): Record<string, unknown> {
  const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (isReasoningModel(model)) {
    return {
      model,
      messages,
      max_completion_tokens: maxTokens + REASONING_ALLOWANCE_TOKENS,
      reasoning_effort: opts?.reasoningEffort ?? defaultEffort,
    };
  }
  return {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: opts?.temperature ?? 0.4,
  };
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** OpenAI Chat Completions connector. Plug in OPENAI_API_KEY to enable. */
export class OpenAiLlmProvider implements LlmProvider {
  name = 'openai';
  enabled = true;
  constructor(private apiKey: string, private model: string, private defaultEffort: ReasoningEffort = 'low') {}

  async generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult> {
    const started = Date.now();
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(openAiRequestBody(this.model, messages, opts, this.defaultEffort)),
    });
    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    // Thrown rather than returned: every caller's fallback runs on a throw, and
    // an empty or half-written reply parsed as a question would put nothing, or
    // half a sentence, in front of the candidate.
    if (choice?.finish_reason === 'length') throw new Error('OpenAI reply truncated (finish_reason length)');
    if (!text.trim()) throw new Error('OpenAI returned an empty reply');
    return {
      text,
      model: this.model,
      inputTokens: count(data.usage?.prompt_tokens),
      outputTokens: count(data.usage?.completion_tokens),
      latencyMs: Date.now() - started,
    };
  }
}
