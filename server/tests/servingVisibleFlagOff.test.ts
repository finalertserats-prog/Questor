import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmApiError, type LlmMessage, type LlmProvider, type LlmResult } from '../src/providers/llm/types.js';

/**
 * R2: with LOCAL_LLM_ENABLED off — today's production configuration — a total
 * provider outage was invisible.
 *
 * Every turn answered 200 with a built-in question. No `serving` note on any
 * turn, so the assessment page's "the AI provider was unavailable for part of
 * this interview" note never appeared and a recruiter read a plainer interview
 * as a worse candidate. `/api/health` reported `llm.layer: "primary"` straight
 * through, so no uptime check saw anything
 * (docs/qa/resilience-2026-09-23.md, R2).
 *
 * The chain does all of this correctly; the chain was switched off, and the
 * path below it had none of the instrumentation. It has it now — and ONLY the
 * instrumentation: what happens is unchanged, which llmFailoverOff.test.ts
 * holds shut from the other side.
 */

const sent: unknown[] = [];
vi.mock('../src/providers/email/index.js', () => ({
  getEmail: () => ({ name: 'fake', configured: true, delivers: true, send: async (m: unknown) => { sent.push(m); return { status: 'sent', id: 'x' }; } }),
}));

const { config } = await import('../src/config.js');
const { generateJson, _setLlmForTests, llmServingStatus, llmHealthSummary } = await import('../src/providers/llm/index.js');
const { _resetServingState, SERVING_RECENCY_MS } = await import('../src/providers/llm/serving.js');
const { traceServing } = await import('../src/providers/llm/servingTrace.js');
const { servingMeta } = await import('../src/services/interviewServing.js');

type Behaviour = () => Promise<string>;

class Scripted implements LlmProvider {
  name = 'openai';
  enabled = true;
  calls = 0;
  constructor(private behaviour: Behaviour) {}
  set(b: Behaviour) { this.behaviour = b; }
  async generate(_m: LlmMessage[]): Promise<LlmResult> {
    this.calls++;
    return { text: await this.behaviour(), model: 'openai-model', inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}

const answers = async () => JSON.stringify({ question: 'What did you own on that team?' });
const quota: Behaviour = async () => { throw new LlmApiError('OpenAI', 429, '{"error":{"code":"insufficient_quota"}}'); };
const network: Behaviour = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
const nonsense: Behaviour = async () => 'not json at all';

let primary: Scripted;

beforeEach(() => {
  _resetServingState();
  primary = new Scripted(answers);
  _setLlmForTests(primary);
  sent.length = 0;
});

afterEach(() => {
  _setLlmForTests(null);
  _resetServingState();
});

const ask = () => generateJson<{ question: string }>({
  fn: 'live_interviewer', purpose: 'live_turn', system: 's', user: 'u',
  validate: (raw) => raw as { question: string },
});

describe('the flag really is off', () => {
  it('is the configuration under test', () => {
    expect(config.llm.local.enabled).toBe(false);
  });
});

describe('a turn served by the primary', () => {
  it('records the primary on the turn', async () => {
    const { served } = await traceServing(() => ask());
    expect(served).toEqual([{ fn: 'live_interviewer', layer: 'primary', provider: 'openai' }]);
  });

  it('is not marked degraded', async () => {
    const { served } = await traceServing(() => ask());
    expect(servingMeta(served).serving).toEqual({ layer: 'primary', degraded: false });
  });
});

describe('a turn the provider could not serve', () => {
  it('records the built-in writer and why', async () => {
    primary.set(quota);
    const { served } = await traceServing(() => ask());
    expect(served).toEqual([{ fn: 'live_interviewer', layer: 'built-in', provider: 'built-in', failure: 'quota' }]);
  });

  it('marks the turn degraded, which is what puts the note on the assessment page', async () => {
    primary.set(quota);
    const { served } = await traceServing(() => ask());
    expect(servingMeta(served).serving).toEqual({ layer: 'built-in', degraded: true, failure: 'quota' });
  });

  it('records the failure class for an unreachable provider too', async () => {
    primary.set(network);
    const { served } = await traceServing(() => ask());
    expect(servingMeta(served).serving?.failure).toBe('network');
  });

  it('does not call a reply it could not use an outage', async () => {
    primary.set(nonsense);
    const { served } = await traceServing(() => ask());
    // The provider answered. The turn took the built-in path, as it always
    // has, but nothing was down and the candidate is not owed a note.
    expect(servingMeta(served).serving).toEqual({ layer: 'built-in', degraded: false });
  });
});

describe('what /api/health says', () => {
  it('says primary while the primary is serving', async () => {
    await ask();
    expect(llmHealthSummary().layer).toBe('primary');
  });

  it('stops saying primary through an outage', async () => {
    primary.set(quota);
    await ask();
    expect(llmHealthSummary().layer).toBe('built-in');
  });

  it('names the failure class on the admin view', async () => {
    primary.set(quota);
    await ask();
    expect(llmHealthSummary().lastFailureClass).toBe('quota');
  });

  it('says primary again as soon as the provider answers', async () => {
    primary.set(quota);
    await ask();
    primary.set(answers);
    await ask();
    expect(llmHealthSummary().layer).toBe('primary');
  });

  it('forgets an outage nothing has confirmed for a while', async () => {
    primary.set(quota);
    await ask();
    const later = Date.now() + SERVING_RECENCY_MS + 1;
    expect(llmServingStatus(later).layer).toBe('primary');
  });

  it('still reports the local fallback as off', async () => {
    primary.set(quota);
    await ask();
    expect(llmServingStatus().local.enabled).toBe(false);
  });
});

describe('nothing else changes', () => {
  it('keeps no failure memory: every turn still tries the primary', async () => {
    primary.set(quota);
    await ask();
    await ask();
    await ask();
    expect(primary.calls).toBe(3);
  });

  it('reports no cooldown on the primary', async () => {
    primary.set(quota);
    await ask();
    expect(llmServingStatus().primary.coolingDown).toBe(false);
  });

  it('sends no outage email', async () => {
    primary.set(quota);
    await ask();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('still hands the caller null so the built-in writer takes the turn', async () => {
    primary.set(quota);
    expect(await ask()).toBeNull();
  });
});
