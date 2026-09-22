import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmApiError, type LlmGenerateOptions, type LlmMessage, type LlmProvider, type LlmResult } from '../src/providers/llm/types.js';

/**
 * The interviewer's conversational calls walk OpenAI -> local model -> built-in
 * writer when LOCAL_LLM_ENABLED is on. A provider that failed for a reason
 * another provider can fix is rested for a while so the next turns do not pay
 * the failure delay, then probed once and brought back on its own.
 */

const COOLDOWN_LONG = 300_000;
const COOLDOWN_SHORT = 30_000;

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return {
    config: {
      ...actual.config,
      signupApproverEmail: 'owner@example.test',
      llm: {
        ...actual.config.llm,
        local: {
          enabled: true, url: 'http://127.0.0.1:11434', model: 'llama3.2:3b', timeoutMs: 15_000, firstTokenMs: 8_000, keepAlive: '24h',
          outageCooldownMs: 300_000, transientCooldownMs: 30_000, maxCooldownMs: 900_000, slowCallMs: 50,
        },
      },
    },
  };
});

const sent: Array<{ to: string; subject: string; text: string }> = [];
vi.mock('../src/providers/email/index.js', () => ({
  getEmail: () => ({
    name: 'fake', configured: true, delivers: true,
    send: async (msg: { to: string; subject: string; text: string }) => { sent.push(msg); return { status: 'sent', id: 'x' }; },
  }),
}));

const { generateJson, _setLlmForTests, _setLocalLlmForTests, llmServingStatus } = await import('../src/providers/llm/index.js');
const { _resetServingState } = await import('../src/providers/llm/serving.js');
const { _resetLlmOutageAlerts } = await import('../src/providers/llm/outageAlert.js');
const { traceServing } = await import('../src/providers/llm/servingTrace.js');
const { prisma } = await import('../src/db.js');

type Behaviour = () => Promise<string>;

class ScriptedProvider implements LlmProvider {
  enabled = true;
  calls: Array<{ messages: LlmMessage[]; opts?: LlmGenerateOptions }> = [];
  constructor(public name: string, private behaviour: Behaviour, enabled = true) { this.enabled = enabled; }
  setBehaviour(b: Behaviour) { this.behaviour = b; }
  async generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult> {
    this.calls.push({ messages, opts });
    const text = await this.behaviour();
    return { text, model: `${this.name}-model`, inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}

const reply = (question: string): Behaviour => async () => JSON.stringify({ question });
const refuse = (status: number, body: string): Behaviour => async () => { throw new LlmApiError('OpenAI', status, body); };
const QUOTA = refuse(429, '{"error":{"code":"insufficient_quota"}}');
const AUTH = refuse(401, '{"error":{"code":"invalid_api_key"}}');
const SERVER = refuse(503, 'upstream');
const BAD_REQUEST = refuse(400, 'Unsupported parameter');
const NETWORK: Behaviour = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };

function ask(fn = 'live_interviewer') {
  return generateJson<{ question: string }>({
    fn, system: 'sys', user: 'usr', timeoutMs: 12_000,
    validate: (raw) => {
      const q = (raw as { question?: unknown }).question;
      if (typeof q !== 'string') throw new Error('bad shape');
      return { question: q };
    },
  });
}

let now = new Date('2026-09-22T10:00:00Z').getTime();
let primary: ScriptedProvider;
let local: ScriptedProvider;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  now = new Date('2026-09-22T10:00:00Z').getTime();
  vi.setSystemTime(now);
  _resetServingState();
  _resetLlmOutageAlerts();
  sent.length = 0;
  primary = new ScriptedProvider('openai', reply('primary question'));
  local = new ScriptedProvider('ollama', reply('local question'));
  _setLlmForTests(primary);
  _setLocalLlmForTests(local);
});

afterEach(() => {
  vi.useRealTimers();
  _setLlmForTests(null);
  _setLocalLlmForTests(null);
});

function advance(ms: number) {
  now += ms;
  vi.setSystemTime(now);
}

describe('failover chain (LOCAL_LLM_ENABLED=true)', () => {
  it('uses the primary when it answers', async () => {
    expect(await ask()).toEqual({ question: 'primary question' });
  });

  it('does not call the local model when the primary answers', async () => {
    await ask();
    expect(local.calls).toHaveLength(0);
  });

  it('serves the request from the local model when the primary is out of credit', async () => {
    primary.setBehaviour(QUOTA);
    expect(await ask()).toEqual({ question: 'local question' });
  });

  it.each([
    ['auth', AUTH],
    ['server', SERVER],
    ['network', NETWORK],
  ])('fails over on a %s failure', async (_label, behaviour) => {
    primary.setBehaviour(behaviour);
    expect(await ask()).toEqual({ question: 'local question' });
  });

  it('leaves the turn to the built-in writer when the primary used up the turn budget', async () => {
    vi.useRealTimers();
    primary.setBehaviour(() => new Promise((resolve) => setTimeout(() => resolve('{"question":"late"}'), 200)));
    const result = await generateJson<{ question: string }>({
      fn: 'live_interviewer', system: 's', user: 'u', timeoutMs: 20,
      validate: (raw) => raw as { question: string },
    });
    expect(result).toBeNull();
  });

  it('sends the next turn after a primary timeout to the local model', async () => {
    vi.useRealTimers();
    primary.setBehaviour(() => new Promise((resolve) => setTimeout(() => resolve('{"question":"late"}'), 200)));
    await generateJson<{ question: string }>({
      fn: 'live_interviewer', system: 's', user: 'u', timeoutMs: 20,
      validate: (raw) => raw as { question: string },
    });
    expect(await ask()).toEqual({ question: 'local question' });
  });

  it('caps the local model at what is left of the turn budget', async () => {
    primary.setBehaviour(QUOTA);
    await generateJson<{ question: string }>({ fn: 'live_interviewer', system: 's', user: 'u', timeoutMs: 9_000, validate: (raw) => raw as { question: string } });
    expect(local.calls[0].opts?.timeoutMs).toBeLessThanOrEqual(9_000);
  });

  it('gives the local model its first-token budget', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    expect(local.calls[0].opts?.firstTokenMs).toBe(8_000);
  });

  it('asks the local model for JSON output', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    expect(local.calls[0].opts?.responseFormat).toBe('json');
  });

  it('gives the local model its own timeout when the turn has room for it', async () => {
    primary.setBehaviour(QUOTA);
    await generateJson<{ question: string }>({ fn: 'live_interviewer', system: 's', user: 'u', timeoutMs: 60_000, validate: (raw) => raw as { question: string } });
    expect(local.calls[0].opts?.timeoutMs).toBe(15_000);
  });

  it('does not fail over on a bad request; the built-in writer takes it as today', async () => {
    primary.setBehaviour(BAD_REQUEST);
    expect(await ask()).toBeNull();
  });

  it('does not call the local model after a bad request', async () => {
    primary.setBehaviour(BAD_REQUEST);
    await ask();
    expect(local.calls).toHaveLength(0);
  });

  it('does not fail over when the primary answers with an unusable reply', async () => {
    primary.setBehaviour(async () => 'not json at all');
    await ask();
    expect(local.calls).toHaveLength(0);
  });

  it('never sends grading or other non-conversational calls to the local model', async () => {
    primary.setBehaviour(QUOTA);
    expect(await ask('competency_grader')).toBeNull();
    expect(local.calls).toHaveLength(0);
  });

  it('returns null (built-in writer) when both layers fail', async () => {
    primary.setBehaviour(QUOTA);
    local.setBehaviour(NETWORK);
    expect(await ask()).toBeNull();
  });

  it('skips a primary that is out of credit on the next turn', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    await ask();
    expect(primary.calls).toHaveLength(1);
  });

  it('keeps skipping it until the long cooldown ends', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    advance(COOLDOWN_LONG - 1_000);
    await ask();
    expect(primary.calls).toHaveLength(1);
  });

  it('probes the primary once the cooldown ends and recovers when it answers', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    advance(COOLDOWN_LONG + 1);
    primary.setBehaviour(reply('primary is back'));
    expect(await ask()).toEqual({ question: 'primary is back' });
  });

  it('rests the primary only briefly after a transient failure', async () => {
    primary.setBehaviour(SERVER);
    await ask();
    advance(COOLDOWN_SHORT + 1);
    await ask();
    expect(primary.calls).toHaveLength(2);
  });

  it('re-rests the primary when the probe fails again', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    advance(COOLDOWN_LONG + 1);
    await ask();
    await ask();
    expect(primary.calls).toHaveLength(2);
  });

  it('rests a local model that cannot be reached, so the turn goes straight to the built-in writer', async () => {
    primary.setBehaviour(QUOTA);
    local.setBehaviour(NETWORK);
    await ask();
    await ask();
    expect(local.calls).toHaveLength(1);
  });

  it('lets only one request probe a recovering primary at a time', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    advance(COOLDOWN_LONG + 1);
    let release: () => void = () => {};
    primary.setBehaviour(() => new Promise((resolve) => { release = () => resolve('{"question":"probe"}'); }));
    const probe = ask();
    await ask();
    release();
    await probe;
    expect(primary.calls).toHaveLength(2);
  });

  it('serves conversational calls from the local model when no primary key is configured', async () => {
    _setLlmForTests(new ScriptedProvider('heuristic', reply('never'), false));
    expect(await ask()).toEqual({ question: 'local question' });
  });

  it('logs the failed primary attempt and the local answer as model executions', async () => {
    primary.setBehaviour(QUOTA);
    const sessionId = `failover-${Date.now()}`;
    await generateJson<{ question: string }>({
      fn: 'live_interviewer', sessionId, system: 's', user: 'u', timeoutMs: 12_000,
      validate: (raw) => raw as { question: string },
    });
    const rows = await prisma.modelExecution.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => [r.provider, JSON.parse(r.safetyJson).ok])).toEqual([['openai', false], ['ollama', true]]);
  });

  it('records the failure class on the failed attempt', async () => {
    primary.setBehaviour(QUOTA);
    const sessionId = `failclass-${Date.now()}`;
    await generateJson<{ question: string }>({
      fn: 'live_interviewer', sessionId, system: 's', user: 'u', timeoutMs: 12_000,
      validate: (raw) => raw as { question: string },
    });
    const row = await prisma.modelExecution.findFirst({ where: { sessionId, provider: 'openai' } });
    expect(JSON.parse(row!.safetyJson).failureClass).toBe('quota');
  });
});

describe('partial outages and backoff', () => {
  it('doubles the cooldown when the probe fails again, so probes never storm', async () => {
    primary.setBehaviour(SERVER);
    await ask();
    advance(COOLDOWN_SHORT + 1);
    await ask(); // the probe fails: now resting for twice as long
    advance(COOLDOWN_SHORT + 1);
    await ask();
    expect(primary.calls).toHaveLength(2);
  });

  it('probes again once the doubled cooldown has passed', async () => {
    primary.setBehaviour(SERVER);
    await ask();
    advance(COOLDOWN_SHORT + 1);
    await ask();
    advance(2 * COOLDOWN_SHORT + 1);
    await ask();
    expect(primary.calls).toHaveLength(3);
  });

  it('treats a primary that answers too slowly twice running as failing', async () => {
    vi.useRealTimers();
    primary.setBehaviour(() => new Promise((resolve) => setTimeout(() => resolve('{"question":"slow"}'), 80)));
    await ask();
    await ask();
    expect(await ask()).toEqual({ question: 'local question' });
  });

  it('still uses a slow answer that did arrive', async () => {
    vi.useRealTimers();
    primary.setBehaviour(() => new Promise((resolve) => setTimeout(() => resolve('{"question":"slow"}'), 80)));
    expect(await ask()).toEqual({ question: 'slow' });
  });

  it('forgives one slow answer followed by a quick one', async () => {
    vi.useRealTimers();
    const slow: Behaviour = () => new Promise((resolve) => setTimeout(() => resolve('{"question":"slow"}'), 80));
    primary.setBehaviour(slow);
    await ask();
    primary.setBehaviour(reply('quick'));
    await ask();
    primary.setBehaviour(slow);
    await ask();
    expect(primary.calls).toHaveLength(3);
  });

  it('retries the local model once when its reply fails validation', async () => {
    primary.setBehaviour(QUOTA);
    let n = 0;
    local.setBehaviour(async () => (n++ === 0 ? 'not json' : '{"question":"second try"}'));
    expect(await ask()).toEqual({ question: 'second try' });
  });

  it('gives up after one retry and leaves the turn to the built-in writer', async () => {
    primary.setBehaviour(QUOTA);
    local.setBehaviour(async () => 'not json');
    await ask();
    expect(local.calls).toHaveLength(2);
  });
});

describe('local variant of a call', () => {
  const variantCall = (variant: unknown) => generateJson<{ question: string }>({
    fn: 'live_interviewer', system: 'BASE', user: 'USER', timeoutMs: 12_000,
    validate: (raw) => raw as { question: string },
    local: variant as never,
  });

  it('keeps the primary prompt unchanged', async () => {
    await variantCall({ systemSuffix: 'GLUE ONLY', userSuffix: 'PLANNED', validate: () => ({ question: 'planned' }) });
    expect(primary.calls[0].messages[0].content).not.toContain('GLUE ONLY');
  });

  it('gives the local model the same system prompt plus the glue instruction', async () => {
    primary.setBehaviour(QUOTA);
    await variantCall({ systemSuffix: 'GLUE ONLY', userSuffix: 'PLANNED', validate: () => ({ question: 'planned' }) });
    expect(local.calls[0].messages[0].content).toMatch(/^BASE[\s\S]*GLUE ONLY$/);
  });

  it('adds the planned substance to the local user message', async () => {
    primary.setBehaviour(QUOTA);
    await variantCall({ systemSuffix: 'GLUE ONLY', userSuffix: 'PLANNED', validate: () => ({ question: 'planned' }) });
    expect(local.calls[0].messages[1].content).toBe('USER\n\nPLANNED');
  });

  it('validates the local reply with the stricter local check', async () => {
    primary.setBehaviour(QUOTA);
    expect(await variantCall({ systemSuffix: 'G', validate: () => ({ question: 'planned question' }) })).toEqual({ question: 'planned question' });
  });

  it('can keep a call off the local model entirely', async () => {
    primary.setBehaviour(QUOTA);
    await variantCall('built-in');
    expect(local.calls).toHaveLength(0);
  });

  it('does not wait on a resting primary for the intent read', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    await ask('candidate_intent');
    expect(primary.calls).toHaveLength(1);
  });

  it('keeps the intent read out of the turn record', async () => {
    const { served } = await traceServing(() => ask('candidate_intent'));
    expect(served).toEqual([]);
  });

  it('never sends the intent read to the local model, where it would queue ahead of the spoken turn', async () => {
    primary.setBehaviour(QUOTA);
    await ask('candidate_intent');
    expect(local.calls).toHaveLength(0);
  });
});

describe('serving trace', () => {
  it('records which layer served each conversational call in a turn', async () => {
    primary.setBehaviour(QUOTA);
    const { served } = await traceServing(() => ask());
    expect(served.map((e: { layer: string }) => e.layer)).toEqual(['local']);
  });

  it('records a turn left to the built-in writer, with the reason', async () => {
    primary.setBehaviour(QUOTA);
    local.setBehaviour(NETWORK);
    const { served } = await traceServing(() => ask());
    expect(served).toEqual([{ fn: 'live_interviewer', layer: 'built-in', provider: 'built-in', failure: 'network' }]);
  });

  it('records the primary when it served', async () => {
    const { served } = await traceServing(() => ask());
    expect(served).toEqual([{ fn: 'live_interviewer', layer: 'primary', provider: 'openai' }]);
  });
});

describe('serving status', () => {
  it('reports the primary layer when nothing has failed', () => {
    expect(llmServingStatus().layer).toBe('primary');
  });

  it('reports the local layer, the cooldown and the failure class while the primary rests', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    const status = llmServingStatus();
    expect({ layer: status.layer, coolingDown: status.primary.coolingDown, cls: status.primary.lastFailureClass })
      .toEqual({ layer: 'local', coolingDown: true, cls: 'quota' });
  });

  it('reports the built-in layer when both are resting', async () => {
    primary.setBehaviour(QUOTA);
    local.setBehaviour(NETWORK);
    await ask();
    expect(llmServingStatus().layer).toBe('built-in');
  });

  it('counts each step down', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    await ask();
    local.setBehaviour(NETWORK);
    await ask();
    expect(llmServingStatus().stepDowns).toEqual({ local: 2, builtIn: 1 });
  });

  it('carries no URL, key or model credential', async () => {
    primary.setBehaviour(AUTH);
    await ask();
    expect(JSON.stringify(llmServingStatus())).not.toMatch(/11434|http|invalid_api_key|sk-/);
  });
});

describe('owner alert', () => {
  it('emails the operator when the primary runs out of credit', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].to).toBe('owner@example.test');
  });

  it('sends one email, not one per failed call', async () => {
    primary.setBehaviour(QUOTA);
    await ask();
    advance(COOLDOWN_LONG + 1);
    await ask();
    advance(COOLDOWN_LONG + 1);
    await ask();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
  });

  it('does not email for a transient outage', async () => {
    primary.setBehaviour(SERVER);
    await ask();
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(0);
  });

  it('says what failed without quoting the provider reply', async () => {
    primary.setBehaviour(refuse(401, 'Incorrect API key provided: sk-abc***xyz'));
    await ask();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].text).not.toContain('sk-abc');
  });
});
