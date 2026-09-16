import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { webhookHostResolvesPrivate } from './webhookUrl.js';
import { startJob } from './jobs.js';

/**
 * Webhook emitter (BRD FR-039).
 *
 * Deliveries are rows. A row is attempted when it is due; a failure sets when
 * it is next due; the job below picks up whatever is due on whichever instance
 * holds the lease. Retries used to be setTimeout chains in one process: a
 * deploy inside the backoff window left the row pending for ever.
 *
 * Two signatures travel with every delivery. `x-questor-signature` is the
 * original HMAC over the body, kept so existing receivers keep verifying.
 * `x-questor-signature-v2` covers `${timestamp}.${body}` with the timestamp in
 * `x-questor-timestamp`, so a receiver that checks it can refuse a replayed
 * delivery. New receivers should verify v2 and a timestamp within a few
 * minutes; v1 is deprecated and will go once the known receivers have moved.
 */

const MAX_ATTEMPTS = 4;
const DELIVER_EVERY_MS = 15_000;
const BATCH = 50;

export function signPayload(body: string): string {
  return crypto.createHmac('sha256', config.webhookSigningSecret).update(body).digest('hex');
}

export function signPayloadV2(timestampMs: number, body: string): string {
  return crypto.createHmac('sha256', config.webhookSigningSecret).update(`${timestampMs}.${body}`).digest('hex');
}

export async function emitEvent(tenantId: string, event: string, payload: unknown): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { tenantId, active: true } });
  const body = JSON.stringify({ event, data: payload, ts: new Date().toISOString() });

  for (const ep of endpoints) {
    const events = ep.events.split(',').map((e) => e.trim());
    if (!(events.includes('*') || events.includes(event))) continue;

    const delivery = await prisma.webhookDelivery.create({
      data: { endpointId: ep.id, event, payloadJson: body, status: 'pending', nextAttemptAt: new Date() },
    });
    // Try at once for latency; the job is the safety net, not the first attempt.
    attempt(delivery.id, ep.url, body).catch((err: unknown) => {
      logger.error({ deliveryId: delivery.id, err: err instanceof Error ? err.message : String(err) }, 'Webhook delivery bookkeeping failed');
    });
  }
}

/** Attempt every delivery that is due. Returns a note for the job run. */
export async function deliverDueWebhooks(now = new Date()): Promise<string> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now }, endpoint: { active: true } },
    include: { endpoint: { select: { url: true } } },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH,
  });
  for (const d of due) {
    await attempt(d.id, d.endpoint.url, d.payloadJson);
  }
  return `${due.length} due`;
}

export function startWebhookDelivery(intervalMs = DELIVER_EVERY_MS): () => void {
  return startJob({ name: 'webhook-delivery', intervalMs, ttlMs: 60_000, fn: () => deliverDueWebhooks() });
}

/**
 * One attempt. Claims the row first with a conditional update so two instances
 * (or the immediate try and the job) cannot both send the same delivery.
 */
async function attempt(deliveryId: string, url: string, body: string): Promise<void> {
  const now = new Date();
  const claimed = await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: 'pending', nextAttemptAt: { lte: now } },
    // Pushed out while in flight; a failure sets the real next time below.
    data: { nextAttemptAt: new Date(now.getTime() + 60_000) },
  });
  if (claimed.count === 0) return;

  const row = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, select: { attempts: true } });
  const attemptNumber = (row?.attempts ?? 0) + 1;

  try {
    // Checked at delivery time as well as at creation: DNS can change between
    // the two, and this is the moment the request actually leaves.
    if (config.nodeEnv !== 'test' && await webhookHostResolvesPrivate(new URL(url).hostname)) {
      throw new Error('destination resolves to a private address');
    }
    const timestamp = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-questor-signature': signPayload(body),
        'x-questor-signature-v2': signPayloadV2(timestamp, body),
        'x-questor-timestamp': String(timestamp),
        'x-questor-delivery': deliveryId,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    await prisma.webhookDelivery.update({ where: { id: deliveryId }, data: { status: 'delivered', attempts: attemptNumber, nextAttemptAt: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attemptNumber < MAX_ATTEMPTS) {
      const backoffMs = 2 ** attemptNumber * 30_000;
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { attempts: attemptNumber, lastError: message, nextAttemptAt: new Date(Date.now() + backoffMs) },
      });
    } else {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: 'failed', attempts: attemptNumber, lastError: message, nextAttemptAt: null },
      });
      logger.warn({ deliveryId, err: message }, 'Webhook delivery failed after retries');
    }
  }
}

/** Counts for the operations view. */
export async function webhookHealth(now = new Date()): Promise<{ pending: number; due: number; failed24h: number }> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000);
  const [pending, due, failed24h] = await Promise.all([
    prisma.webhookDelivery.count({ where: { status: 'pending' } }),
    prisma.webhookDelivery.count({ where: { status: 'pending', nextAttemptAt: { lte: now } } }),
    prisma.webhookDelivery.count({ where: { status: 'failed', createdAt: { gte: dayAgo } } }),
  ]);
  return { pending, due, failed24h };
}
