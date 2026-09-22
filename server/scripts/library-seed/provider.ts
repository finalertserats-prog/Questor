import type { LlmMessage, LlmProvider, LlmResult } from '../../src/providers/llm/types.js';
import { laneModel } from '../../src/library/seedFormat.js';
import { classifyFailure, type CliResult, type CliRunner, type Lane, type RunOptions } from './lanes.js';

/**
 * A lane as the server's `LlmProvider`, so the seed run sends the library's
 * own prompt builders (generator.ts, critic.ts) unchanged. A CLI has no
 * separate system channel, so the system prompt leads and the user prompt
 * follows under a marker.
 */

export class LaneLimitError extends Error {
  /** `beforeCall`: the lane was already parked, so no call was made. */
  constructor(readonly lane: Lane, readonly until: Date, readonly parsed: boolean, readonly beforeCall = false) {
    super(`${lane} usage limit until ${until.toISOString()}`);
    this.name = 'LaneLimitError';
  }
}

export class LaneCallError extends Error {
  constructor(readonly lane: Lane, readonly reason: string) {
    super(`${lane} call failed: ${reason}`);
    this.name = 'LaneCallError';
  }
}

export interface CallRecord {
  readonly lane: Lane;
  readonly ms: number;
  readonly ok: boolean;
  readonly reason?: string;
  readonly promptChars: number;
  readonly replyChars: number;
}

const PREAMBLE = 'You are being called non-interactively to author structured content. Do not use tools, do not read or write files, do not ask questions. Follow the instructions below exactly and reply with the JSON they ask for and nothing else.';

export function composePrompt(messages: readonly LlmMessage[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const user = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
  return [PREAMBLE, '=== INSTRUCTIONS ===', system, '=== MATERIAL ===', user].join('\n\n');
}

/** A reply that is a limit notice rather than content: short, no JSON, and says so. */
function looksLikeLimitNotice(result: CliResult): boolean {
  return !result.stdout.includes('{') && result.stdout.length < 600 && classifyFailure(result, new Date()).kind === 'usage_limit';
}

/** Rough token count for the run log; the CLIs do not report usage. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function cliProvider(lane: Lane, runner: CliRunner, opts: RunOptions & { readonly now?: () => Date; readonly onCall?: (call: CallRecord) => void }): LlmProvider {
  const now = opts.now ?? (() => new Date());
  return {
    name: laneModel(lane),
    enabled: true,
    async generate(messages): Promise<LlmResult> {
      const prompt = composePrompt(messages);
      const result = await runner(lane, prompt, opts);
      const failed = !result.ok || result.stdout.trim().length === 0 || looksLikeLimitNotice(result);
      if (failed) {
        const failure = classifyFailure(result, now());
        opts.onCall?.({ lane, ms: result.ms, ok: false, reason: failure.kind === 'usage_limit' ? 'usage_limit' : failure.reason, promptChars: prompt.length, replyChars: result.stdout.length });
        if (failure.kind === 'usage_limit') throw new LaneLimitError(lane, failure.until, failure.parsed);
        throw new LaneCallError(lane, failure.reason);
      }
      opts.onCall?.({ lane, ms: result.ms, ok: true, promptChars: prompt.length, replyChars: result.stdout.length });
      return { text: result.stdout, model: laneModel(lane), inputTokens: estimateTokens(prompt.length), outputTokens: estimateTokens(result.stdout.length), latencyMs: result.ms };
    },
  };
}
