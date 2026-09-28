import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  tenantId: string;
  actorId?: string;
  actorType?: 'user' | 'system' | 'model';
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
}

/** One mapping from an entry to its columns, so the two writers cannot drift apart. */
function auditRow(opts: AuditEntry) {
  return {
    tenantId: opts.tenantId,
    actorId: opts.actorId ?? 'system',
    actorType: opts.actorType ?? 'system',
    action: opts.action,
    entityType: opts.entityType ?? '',
    entityId: opts.entityId ?? '',
    beforeJson: opts.before !== undefined ? JSON.stringify(opts.before) : '',
    afterJson: opts.after !== undefined ? JSON.stringify(opts.after) : '',
    requestId: opts.requestId ?? '',
  };
}

/**
 * Record that something happened, without ever failing the thing it records.
 *
 * On the shared client and swallowing its own errors, both deliberately: an
 * audit written inside somebody's transaction would survive a rollback and
 * claim something that never landed, and a trail that cannot be written is not
 * a reason to refuse the action it describes.
 */
export async function logAudit(opts: AuditEntry): Promise<void> {
  try {
    await prisma.auditEvent.create({ data: auditRow(opts) });
  } catch (err) {
    logger.error({ err: String(err), action: opts.action }, 'Failed to write audit event');
  }
}

/**
 * The same record, written inside the caller's transaction — both or neither.
 *
 * The exact opposite trade from `logAudit`, for the case where the audit is
 * not commentary on the work but part of it. A migration that changes a stored
 * record and then loses its audit has altered something with nothing saying it
 * did — and worse, nothing that will notice: the row no longer looks like it
 * needs migrating, so no later run revisits it and the omission is permanent
 * and silent.
 *
 * So this neither swallows nor writes outside the transaction. A failure here
 * rolls the caller's work back, which leaves the record exactly as it was and
 * therefore still due for another attempt.
 */
export async function logAuditIn(tx: Prisma.TransactionClient, opts: AuditEntry): Promise<void> {
  await tx.auditEvent.create({ data: auditRow(opts) });
}
