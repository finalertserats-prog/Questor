import { prisma } from '../db.js';
import { logger } from '../logger.js';

export async function logAudit(opts: {
  tenantId: string;
  actorId?: string;
  actorType?: 'user' | 'system' | 'model';
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  requestId?: string;
}): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        tenantId: opts.tenantId,
        actorId: opts.actorId ?? 'system',
        actorType: opts.actorType ?? 'system',
        action: opts.action,
        entityType: opts.entityType ?? '',
        entityId: opts.entityId ?? '',
        beforeJson: opts.before !== undefined ? JSON.stringify(opts.before) : '',
        afterJson: opts.after !== undefined ? JSON.stringify(opts.after) : '',
        requestId: opts.requestId ?? '',
      },
    });
  } catch (err) {
    logger.error({ err: String(err), action: opts.action }, 'Failed to write audit event');
  }
}
