import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Webhook emitter (BRD FR-039). Signs payloads with HMAC-SHA256 and records
// delivery attempts. Idempotency is provided by the delivery id header.

const MAX_ATTEMPTS = 4;

export function signPayload(body: string): string {
  return crypto.createHmac('sha256', config.webhookSigningSecret).update(body).digest('hex');
}

export async function emitEvent(tenantId: string, event: string, payload: unknown): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { tenantId, active: true } });
  const body = JSON.stringify({ event, data: payload, ts: new Date().toISOString() });

  for (const ep of endpoints) {
    const events = ep.events.split(',').map((e) => e.trim());
    if (!(events.includes('*') || events.includes(event))) continue;

    const delivery = await prisma.webhookDelivery.create({
      data: { endpointId: ep.id, event, payloadJson: body, status: 'pending' },
    });

    startDelivery(ep.url, body, delivery.id, 1);
  }
}

/**
 * Deliveries whose retry chain died with the process. The chain lives in
 * memory (setTimeout), so a deploy or crash inside the backoff window left the
 * row `pending` for ever, and the tenant's integration silently missed the
 * event. Called once at startup; returns how many were picked up again.
 */
export async function requeuePendingDeliveries(): Promise<number> {
  const pending = await prisma.webhookDelivery.findMany({
    where: { status: 'pending', endpoint: { active: true } },
    include: { endpoint: { select: { url: true } } },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  for (const d of pending) {
    // Attempts already spent count against the same ceiling; a delivery that
    // had failed three times before the restart gets one more, not four.
    startDelivery(d.endpoint.url, d.payloadJson, d.id, d.attempts + 1);
  }
  if (pending.length > 0) logger.info({ count: pending.length }, 'Re-queued webhook deliveries left pending by a previous process');
  return pending.length;
}

// Fire-and-forget with the rejection observed. `void deliver(...)` alone let a
// failure inside the catch block (the bookkeeping update itself throwing)
// surface only as an unhandled rejection.
function startDelivery(url: string, body: string, deliveryId: string, attempt: number): void {
  deliver(url, body, deliveryId, attempt).catch((err: unknown) => {
    logger.error({ deliveryId, err: err instanceof Error ? err.message : String(err) }, 'Webhook delivery bookkeeping failed');
  });
}

async function deliver(url: string, body: string, deliveryId: string, attempt: number): Promise<void> {
  if (attempt > MAX_ATTEMPTS) {
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'failed', lastError: 'attempts exhausted' } });
    return;
  }
  // Signed per attempt rather than once at emit time, so a re-queued delivery
  // after a restart is signed with the secret in force now.
  const signature = signPayload(body);
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
    if (attempt < MAX_ATTEMPTS) {
      const backoff = 2 ** attempt * 500;
      setTimeout(() => startDelivery(url, body, deliveryId, attempt + 1), backoff);
      await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { attempts: attempt, lastError: String(err) } });
    } else {
      await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'failed', attempts: attempt, lastError: String(err) } });
      logger.warn({ deliveryId, err: String(err) }, 'Webhook delivery failed after retries');
    }
  }
}
