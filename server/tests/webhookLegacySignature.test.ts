import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config, parseV1SignatureSetting } from '../src/config.js';
import { wipe } from '../src/seed/demoData.js';
import {
  deliverDueWebhooks, deliveryHeaders, emitEvent, legacySignatureStatus, sendsLegacySignature, signPayload, signPayloadV2,
} from '../src/services/webhooks.js';

/**
 * Retiring the original, untimestamped v1 signature without breaking anyone.
 *
 * Existing webhooks keep receiving v1 (the migration sets their flag), new ones
 * are v2-only, an admin can switch v1 off per webhook, and the operator can
 * switch it off everywhere with WEBHOOK_V1_SIGNATURE=off. Each of those is a
 * header a real receiver either gets or does not, so that is what is asserted.
 */

const app = createApp();
let adminToken = '';
let tenantId = '';
const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const calls: Array<{ headers: Record<string, string>; body: string }> = [];
// The first attempt runs in the background after emitEvent returns. Wait until
// every delivery has finished it (delivered, or a failure recorded) instead of a
// fixed pause, which a loaded machine outran.
const settle = async (timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (await prisma.webhookDelivery.count({ where: { status: 'pending', attempts: 0 } }) > 0) {
    if (Date.now() > deadline) throw new Error('webhook deliveries did not settle');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@hooks.local', password: 'fixture-admin-passphrase', name: 'Hook Admin', tenantName: 'Hook Signature Org',
  });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;
});

beforeEach(async () => {
  calls.length = 0;
  config.webhookV1Signature = 'on';
  await prisma.webhookDelivery.deleteMany();
  await prisma.webhookEndpoint.deleteMany();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ headers: init.headers, body: init.body });
    return { ok: true, status: 200 } as Response;
  }));
});

afterEach(() => {
  config.webhookV1Signature = 'on';
  vi.unstubAllGlobals();
});

const legacyHook = () => prisma.webhookEndpoint.create({
  data: { tenantId, url: 'https://hooks.example.com/old', events: '*', sendLegacySignature: true },
});

describe('a new webhook', () => {
  it('is v2-only by default', async () => {
    const hook = await prisma.webhookEndpoint.create({ data: { tenantId, url: 'https://hooks.example.com/new' } });

    expect(hook.sendLegacySignature).toBe(false);
  });

  it('is v2-only when an admin creates it through the API', async () => {
    const res = await request(app).post('/api/admin/webhooks').set(auth()).send({ url: 'https://hooks.example.com/new' });

    expect([res.status, res.body.webhook.sendLegacySignature]).toEqual([201, false]);
  });

  it('receives no v1 header', async () => {
    await prisma.webhookEndpoint.create({ data: { tenantId, url: 'https://hooks.example.com/new' } });

    await emitEvent(tenantId, 'assessment.ready', { id: 'x' });
    await settle();

    expect('x-questor-signature' in calls[0].headers).toBe(false);
  });

  it('still receives a valid v2 signature and timestamp', async () => {
    await prisma.webhookEndpoint.create({ data: { tenantId, url: 'https://hooks.example.com/new' } });

    await emitEvent(tenantId, 'assessment.ready', { id: 'x' });
    await settle();

    const { headers, body } = calls[0];
    expect(headers['x-questor-signature-v2']).toBe(signPayloadV2(Number(headers['x-questor-timestamp']), body));
  });
});

describe('an existing webhook that still sends v1', () => {
  it('receives both signatures', async () => {
    await legacyHook();

    await emitEvent(tenantId, 'assessment.ready', { id: 'x' });
    await settle();

    const { headers, body } = calls[0];
    expect([headers['x-questor-signature'], headers['x-questor-signature-v2']])
      .toEqual([signPayload(body), signPayloadV2(Number(headers['x-questor-timestamp']), body)]);
  });

  it('stops receiving v1 on a retry once the flag is switched off', async () => {
    const hook = await legacyHook();
    await prisma.webhookDelivery.create({
      data: { endpointId: hook.id, event: 'e', payloadJson: '{}', status: 'pending', nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await prisma.webhookEndpoint.update({ where: { id: hook.id }, data: { sendLegacySignature: false } });

    await deliverDueWebhooks();

    expect('x-questor-signature' in calls[0].headers).toBe(false);
  });

  it('keeps v1 on a retry while the flag is on', async () => {
    const hook = await legacyHook();
    await prisma.webhookDelivery.create({
      data: { endpointId: hook.id, event: 'e', payloadJson: '{}', status: 'pending', nextAttemptAt: new Date(Date.now() - 1000) },
    });

    await deliverDueWebhooks();

    expect(calls[0].headers['x-questor-signature']).toBe(signPayload('{}'));
  });
});

describe('the WEBHOOK_V1_SIGNATURE kill switch', () => {
  it('removes v1 from a webhook that is still flagged for it', async () => {
    await legacyHook();
    config.webhookV1Signature = 'off';

    await emitEvent(tenantId, 'assessment.ready', { id: 'x' });
    await settle();

    expect('x-questor-signature' in calls[0].headers).toBe(false);
  });

  it('never adds v1 to a webhook that is not flagged', () => {
    expect(sendsLegacySignature({ sendLegacySignature: false }, 'on')).toBe(false);
  });

  it('defers to the webhook when it is on', () => {
    expect(sendsLegacySignature({ sendLegacySignature: true }, 'on')).toBe(true);
  });

  it('wins over the webhook when it is off', () => {
    expect(sendsLegacySignature({ sendLegacySignature: true }, 'off')).toBe(false);
  });

  it('reads unset as on, so nothing changes until the owner decides', () => {
    expect(parseV1SignatureSetting('')).toBe('on');
  });

  it('accepts off in any case', () => {
    expect(parseV1SignatureSetting(' OFF ')).toBe('off');
  });

  it('refuses a value it does not understand rather than guessing', () => {
    // "false", "0" or "disabled" could mean either thing to whoever typed it.
    // Guessing wrong either breaks receivers or silently keeps v1 alive.
    expect(() => parseV1SignatureSetting('false')).toThrow(/WEBHOOK_V1_SIGNATURE/);
  });
});

describe('the delivery headers', () => {
  it('carry v1 only when asked to', () => {
    const headers = deliveryHeaders({ body: '{}', deliveryId: 'd1', timestampMs: 1, legacy: false });

    expect(Object.keys(headers).sort()).toEqual([
      'content-type', 'x-questor-delivery', 'x-questor-signature-v2', 'x-questor-timestamp',
    ]);
  });

  it('add v1 when asked to', () => {
    const headers = deliveryHeaders({ body: '{}', deliveryId: 'd1', timestampMs: 1, legacy: true });

    expect(headers['x-questor-signature']).toBe(signPayload('{}'));
  });
});

describe('switching v1 off from the admin console', () => {
  it('turns the flag off and records who did it', async () => {
    const hook = await legacyHook();

    const res = await request(app).patch(`/api/admin/webhooks/${hook.id}`).set(auth()).send({ sendLegacySignature: false });

    const audit = await prisma.auditEvent.findFirst({ where: { action: 'webhook.legacy_signature.changed', entityId: hook.id } });
    expect([res.status, res.body.webhook.sendLegacySignature, Boolean(audit)]).toEqual([200, false, true]);
  });

  it('can turn it back on, for a receiver that turned out not to verify v2 yet', async () => {
    const hook = await prisma.webhookEndpoint.create({ data: { tenantId, url: 'https://hooks.example.com/new' } });

    const res = await request(app).patch(`/api/admin/webhooks/${hook.id}`).set(auth()).send({ sendLegacySignature: true });

    expect(res.body.webhook.sendLegacySignature).toBe(true);
  });

  it('refuses anything else in the body', async () => {
    const hook = await legacyHook();

    const res = await request(app).patch(`/api/admin/webhooks/${hook.id}`).set(auth())
      .send({ sendLegacySignature: false, url: 'http://169.254.169.254/' });

    expect(res.status).toBe(400);
  });

  it('cannot reach another tenant\'s webhook', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other Hook Org' } });
    const hook = await prisma.webhookEndpoint.create({
      data: { tenantId: other.id, url: 'https://hooks.example.com/theirs', sendLegacySignature: true },
    });

    const res = await request(app).patch(`/api/admin/webhooks/${hook.id}`).set(auth()).send({ sendLegacySignature: false });

    const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: hook.id } });
    expect([res.status, after.sendLegacySignature]).toEqual([404, true]);
  });

  it('is not for recruiters', async () => {
    const hook = await legacyHook();
    const recruiter = await prisma.user.create({
      data: { tenantId, email: `rec-${hook.id}@hooks.local`, name: 'Rec', passwordHash: 'x', role: 'recruiter' },
    });
    const { signToken } = await import('../src/services/auth.js');
    const token = signToken({ userId: recruiter.id, tenantId, role: 'recruiter', email: recruiter.email });

    const res = await request(app).patch(`/api/admin/webhooks/${hook.id}`)
      .set({ Authorization: `Bearer ${token}` }).send({ sendLegacySignature: false });

    expect(res.status).toBe(403);
  });

  it('tells the console whether the kill switch is on', async () => {
    config.webhookV1Signature = 'off';

    const res = await request(app).get('/api/admin/webhooks').set(auth());

    expect(res.body.legacySignatureDisabledEverywhere).toBe(true);
  });
});

describe('the operations view', () => {
  it('counts the active webhooks still sending v1', async () => {
    await legacyHook();
    await legacyHook();
    await prisma.webhookEndpoint.create({ data: { tenantId, url: 'https://hooks.example.com/new' } });
    await prisma.webhookEndpoint.create({
      data: { tenantId, url: 'https://hooks.example.com/paused', active: false, sendLegacySignature: true },
    });

    const res = await request(app).get('/api/admin/ops').set(auth());

    expect(res.body.webhooks.legacySignature).toEqual({ killSwitch: 'on', flagged: 2, sending: 2 });
  });

  it('reports none sending once the kill switch is off, and still how many are flagged', async () => {
    await legacyHook();
    config.webhookV1Signature = 'off';

    expect(await legacySignatureStatus()).toEqual({ killSwitch: 'off', flagged: 1, sending: 0 });
  });
});
