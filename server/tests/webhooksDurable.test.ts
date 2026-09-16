import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { deliverDueWebhooks, emitEvent, signPayload, signPayloadV2, webhookHealth } from '../src/services/webhooks.js';
import { webhookHostResolvesPrivate } from '../src/services/webhookUrl.js';

/**
 * Webhook deliveries as rows with a due time, not setTimeout chains. A restart
 * must not lose a retry; a receiver must be able to refuse a replay.
 */

let tenantId = '';
let endpointId = '';
const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let respondWith = 200;

beforeEach(async () => {
  calls.length = 0;
  respondWith = 200;
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.tenant.deleteMany({ where: { name: 'Hook Org' } });
  const tenant = await prisma.tenant.create({ data: { name: 'Hook Org' } });
  tenantId = tenant.id;
  const ep = await prisma.webhookEndpoint.create({ data: { tenantId, url: 'https://hooks.example.com/questor', events: '*' } });
  endpointId = ep.id;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: respondWith < 400, status: respondWith } as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('a delivery that succeeds', () => {
  it('is marked delivered', async () => {
    await emitEvent(tenantId, 'assessment.ready', { id: 'x' });
    await settle();

    const row = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId } });
    expect(row.status).toBe('delivered');
  });

  it('carries both signatures and a timestamp', async () => {
    await emitEvent(tenantId, 'assessment.ready', { id: 'x' });
    await settle();

    const { headers, body } = calls[0];
    const ts = Number(headers['x-questor-timestamp']);
    expect([headers['x-questor-signature'], headers['x-questor-signature-v2']]).toEqual([signPayload(body), signPayloadV2(ts, body)]);
  });
});

describe('a delivery that fails', () => {
  it('is scheduled for a later attempt rather than retried from memory', async () => {
    respondWith = 500;
    await emitEvent(tenantId, 'assessment.ready', { id: 'x' });
    await settle();

    const row = await prisma.webhookDelivery.findFirstOrThrow({ where: { endpointId } });
    expect([row.status, row.attempts, row.nextAttemptAt !== null && row.nextAttemptAt > new Date()]).toEqual(['pending', 1, true]);
  });

  it('is picked up by the delivery job once due, even after a restart', async () => {
    const row = await prisma.webhookDelivery.create({
      data: { endpointId, event: 'assessment.ready', payloadJson: '{}', status: 'pending', attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await deliverDueWebhooks();

    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('delivered');
  });

  it('is not sent twice when two runners see it due at once', async () => {
    await prisma.webhookDelivery.create({
      data: { endpointId, event: 'assessment.ready', payloadJson: '{}', status: 'pending', nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await Promise.all([deliverDueWebhooks(), deliverDueWebhooks()]);

    expect(calls).toHaveLength(1);
  });

  it('gives up after the last attempt and says so', async () => {
    respondWith = 500;
    const row = await prisma.webhookDelivery.create({
      data: { endpointId, event: 'assessment.ready', payloadJson: '{}', status: 'pending', attempts: 3, nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await deliverDueWebhooks();

    const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.status, after.attempts]).toEqual(['failed', 4]);
  });
});

describe('the operations counts', () => {
  it('report what is pending, due and recently failed', async () => {
    await prisma.webhookDelivery.create({ data: { endpointId, event: 'e', payloadJson: '{}', status: 'pending', nextAttemptAt: new Date(Date.now() - 1000) } });
    await prisma.webhookDelivery.create({ data: { endpointId, event: 'e', payloadJson: '{}', status: 'failed' } });

    expect(await webhookHealth()).toEqual({ pending: 1, due: 1, failed24h: 1 });
  });
});

describe('a destination that resolves inward', () => {
  it('is caught by name, not only by literal address', async () => {
    const lookup = async () => [{ address: '10.0.0.7' }];

    expect(await webhookHostResolvesPrivate('hooks.example.com', lookup)).toBe(true);
  });

  it('is not flagged when the name resolves to a public address', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }];

    expect(await webhookHostResolvesPrivate('hooks.example.com', lookup)).toBe(false);
  });
});
