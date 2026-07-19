import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Webhook emitter (BRD FR-039). Signs payloads with HMAC-SHA256 and records
// delivery attempts. Idempotency is provided by the delivery id header.

export function signPayload(body: string): string {
  return crypto.createHmac('sha256', config.webhookSigningSecret).update(body).digest('hex');
}

export async function emitEvent(tenantId: string, event: string, payload: unknown): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { tenantId, active: true } });
  const body = JSON.stringify({ event, data: payload, ts: new Date().toISOString() });
  const signature = signPayload(body);

  for (const ep of endpoints) {
    const events = ep.events.split(',').map((e) => e.trim());
    if (!(events.includes('*') || events.includes(event))) continue;

    const delivery = await prisma.webhookDelivery.create({
      data: { endpointId: ep.id, event, payloadJson: body, status: 'pending' },
    });

    void deliver(ep.url, body, signature, delivery.id);
  }
}

async function deliver(url: string, body: string, signature: string, deliveryId: string, attempt = 1): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-questor-signature': signature,
        'x-questor-delivery': deliveryId,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'delivered', attempts: attempt } });
  } catch (err) {
    if (attempt < 4) {
      const backoff = 2 ** attempt * 500;
      setTimeout(() => void deliver(url, body, signature, deliveryId, attempt + 1), backoff);
      await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attempts: attempt, lastError: String(err) } });
    } else {
      await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'failed', attempts: attempt, lastError: String(err) } });
      logger.warn({ url, err: String(err) }, 'Webhook delivery failed after retries');
    }
  }
}
