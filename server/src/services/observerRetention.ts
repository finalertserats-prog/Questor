import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { logAudit } from './audit.js';
import { observationModelRef } from './observerQuotes.js';

/**
 * Lifecycle of AI-observer records (transcripts and evidence quotes of human
 * rounds). Kept beside dataRights.ts rather than inside it so that file stays
 * under the size limit; dataRights calls in here from erasure and the sweep,
 * so the two deletion paths still share one ordering.
 */

type Counter = (label: string, fn: () => Promise<{ count: number }>) => Promise<void>;

/** Whether any of this candidate's observations is under legal hold. */
export async function candidateHasHeldObservation(candidateId: string, tenantId?: string): Promise<boolean> {
  const held = await prisma.roundObservation.count({
    where: { candidateId, legalHold: true, ...(tenantId ? { tenantId } : {}) },
  });
  return held > 0;
}

async function deleteObservations(tx: Prisma.TransactionClient, ids: string[], count: Counter): Promise<void> {
  if (ids.length === 0) return;
  // Failed model calls can log the start of a reply that quotes the candidate.
  await count('observerModelExecutions', () => tx.modelExecution.deleteMany({ where: { sessionId: { in: ids.map(observationModelRef) } } }));
  await count('observationSegments', () => tx.observationSegment.deleteMany({ where: { observationId: { in: ids } } }));
  await count('observations', () => tx.roundObservation.deleteMany({ where: { id: { in: ids } } }));
}

/**
 * Delete every observation of a candidate. Must run before the candidate's
 * rounds are deleted: an observation holds a foreign key onto its round.
 */
export async function deleteCandidateObservations(tx: Prisma.TransactionClient, candidateId: string, count: Counter): Promise<void> {
  const rows = await tx.roundObservation.findMany({ where: { candidateId }, select: { id: true } });
  await deleteObservations(tx, rows.map((r) => r.id), count);
}

/**
 * Delete observations whose retention window has closed.
 *
 * The clock starts when the round's observer ended, when the record stopped
 * changing. A record that never ended (declined, or a room nobody closed) ages
 * from creation, unless it is still listening: a live capture is never swept
 * out from under the interviewer. A hold on the observation, or on any of the
 * candidate's interviews or files, spares it, matching the rest of the sweep.
 */
export async function purgeExpiredObservations(now: Date, days: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  // One predicate for selecting and for deleting: a hold placed, or capture
  // started, between the two must still win.
  const dueWhere: Prisma.RoundObservationWhereInput = {
    legalHold: false,
    status: { not: 'LISTENING' },
    OR: [{ endedAt: { lte: cutoff } }, { endedAt: null, createdAt: { lte: cutoff } }],
    round: { pipeline: { candidate: { interviews: { none: { legalHold: true } }, artifacts: { none: { legalHold: true } } } } },
  };
  const due = await prisma.roundObservation.findMany({ where: dueWhere, select: { id: true, tenantId: true } });

  let purged = 0;
  for (const row of due) {
    const deleted: Record<string, number> = {};
    const count: Counter = async (label, fn) => { deleted[label] = (deleted[label] ?? 0) + (await fn()).count; };
    try {
      await prisma.$transaction(async (tx) => {
        const still = await tx.roundObservation.count({ where: { AND: [{ id: row.id }, dueWhere] } });
        if (still === 1) await deleteObservations(tx, [row.id], count);
      });
    } catch (err) {
      logger.error({ err: String(err), observationId: row.id }, 'Failed to purge expired observation');
      continue;
    }
    if (!deleted.observations) continue;
    purged += 1;
    // Counts only: the audit trail outlives the data and must not quote it.
    await logAudit({
      tenantId: row.tenantId, actorType: 'system', actorId: 'retention-sweep',
      action: 'observer.purged', entityType: 'RoundObservation', entityId: row.id,
      after: { reason: 'retention window elapsed', retentionDays: days, deleted },
    });
  }
  return purged;
}
