import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { judgeLlmServing } from '../src/services/systemHealthDelivery.js';
import type { LlmServingStatus } from '../src/providers/llm/index.js';

/**
 * The deploy's verify step reads /api/health, so its existing fields must stay
 * exactly as they are. The serving layer is added beside them, never in place
 * of them, and carries no secret.
 */

const app = createApp();

function status(over: Partial<LlmServingStatus> = {}): LlmServingStatus {
  return {
    layer: 'primary',
    primary: { provider: 'openai', configured: true, coolingDown: false, cooldownEndsAt: null, lastFailureClass: null, lastFailureAt: null },
    local: { enabled: true, model: 'llama3.2:3b', coolingDown: false, cooldownEndsAt: null, lastFailureClass: null, lastFailureAt: null },
    stepDowns: { local: 0, builtIn: 0 },
    ...over,
  };
}

describe('/api/health', () => {
  it('keeps every field deploy verification depends on', async () => {
    const res = await request(app).get('/api/health');
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(['status', 'service', 'commit', 'database', 'draining', 'ts']));
  });

  it('adds only the serving layer, since the route is public', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.llm).toEqual({ layer: 'built-in' });
  });
});

describe('judgeLlmServing', () => {
  it('is informational while the local fallback is off', () => {
    const s = status({ local: { ...status().local, enabled: false, model: null } });
    expect(judgeLlmServing(s).status).toBe('info');
  });

  it('is ok while the primary serves with the fallback ready', () => {
    expect(judgeLlmServing(status()).status).toBe('ok');
  });

  it('warns while the local model serves interviews', () => {
    const s = status({ layer: 'local', primary: { ...status().primary, coolingDown: true, lastFailureClass: 'quota' } });
    expect(judgeLlmServing(s).status).toBe('warn');
  });

  it('tells the operator to top up when the primary is out of credit', () => {
    const s = status({ layer: 'local', primary: { ...status().primary, coolingDown: true, lastFailureClass: 'quota' } });
    expect(judgeLlmServing(s).action).toMatch(/credit/i);
  });

  it('fails when interviews are down to the built-in writer', () => {
    const s = status({ layer: 'built-in', primary: { ...status().primary, coolingDown: true, lastFailureClass: 'auth' }, local: { ...status().local, coolingDown: true, lastFailureClass: 'network' } });
    expect(judgeLlmServing(s).status).toBe('fail');
  });
});
