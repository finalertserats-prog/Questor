import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { logAudit } from './audit.js';

// Candidate data-rights operations.
//
// Erasure is a legal obligation, not a convenience: GDPR Art. 17 (right to
// erasure), India DPDP s.8(6)/8(9) (delete once the recruitment purpose is
// complete), and Illinois AIVIA s.20 (delete within 30 days of request,
// including copies). Retention limits exist for the same reason — artifacts
// carry a retentionDays value that nothing previously enforced, so transcripts
// were kept indefinitely.
//
// The audit trail deliberately survives erasure. It records THAT a candidate's
// data was deleted, by whom and when, but holds no personal data itself — you
// cannot demonstrate compliance with a deletion request whose record you also
// deleted.

export interface ErasureResult {
  candidateId: string;
  deleted: Record<string, number>;
  erasedAt: string;
}

/**
 * Permanently erase one candidate and everything derived from them, in
 * dependency order. Scoped by tenant so a caller cannot erase across tenants.
 */
export async function eraseCandidate(o: {
  tenantId: string;
  candidateId: string;
  actorId: string;
  reason: string;
}): Promise<ErasureResult> {
  const candidate = await prisma.candidate.findFirst({
    where: { id: o.candidateId, tenantId: o.tenantId },
    select: { id: true },
  });
  if (!candidate) throw new Error('Candidate not found in this tenant');

  const sessions = await prisma.interviewSession.findMany({
    where: { candidateId: o.candidateId, tenantId: o.tenantId },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  const profiles = await prisma.candidateProfileVersion.findMany({
    where: { candidateId: o.candidateId },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);

  const nodes = profileIds.length
    ? await prisma.evidenceNode.findMany({ where: { profileId: { in: profileIds } }, select: { id: true } })
    : [];
  const nodeIds = nodes.map((n) => n.id);

  const assessments = sessionIds.length
    ? await prisma.assessmentVersion.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true } })
    : [];
  const assessmentIds = assessments.map((a) => a.id);

  const deleted: Record<string, number> = {};
  const count = async (label: string, fn: () => Promise<{ count: number }>) => {
    deleted[label] = (await fn()).count;
  };

  // Ordered leaf-first so foreign keys are never left dangling.
  await prisma.$transaction(async () => {
    if (assessmentIds.length) {
      await count('humanReviews', () => prisma.humanReview.deleteMany({ where: { assessmentId: { in: assessmentIds } } }));
      await count('assessments', () => prisma.assessmentVersion.deleteMany({ where: { id: { in: assessmentIds } } }));
    }
    if (nodeIds.length) {
      await count('evidenceEdges', () => prisma.evidenceEdge.deleteMany({
        where: { OR: [{ fromId: { in: nodeIds } }, { toId: { in: nodeIds } }] },
      }));
      await count('evidenceNodes', () => prisma.evidenceNode.deleteMany({ where: { id: { in: nodeIds } } }));
    }
    if (sessionIds.length) {
      await count('turns', () => prisma.turn.deleteMany({ where: { sessionId: { in: sessionIds } } }));
      await count('invitations', () => prisma.invitation.deleteMany({ where: { sessionId: { in: sessionIds } } }));
      await count('plans', () => prisma.interviewPlanVersion.deleteMany({ where: { sessionId: { in: sessionIds } } }));
      // Model executions record prompts/outputs that can quote the candidate.
      await count('modelExecutions', () => prisma.modelExecution.deleteMany({ where: { sessionId: { in: sessionIds } } }));
    }
    await count('artifacts', () => prisma.artifact.deleteMany({
      where: { OR: [{ candidateId: o.candidateId }, ...(sessionIds.length ? [{ sessionId: { in: sessionIds } }] : [])] },
    }));
    if (sessionIds.length) {
      await count('sessions', () => prisma.interviewSession.deleteMany({ where: { id: { in: sessionIds } } }));
    }
    if (profileIds.length) {
      await count('profiles', () => prisma.candidateProfileVersion.deleteMany({ where: { id: { in: profileIds } } }));
    }
    await count('candidates', () => prisma.candidate.deleteMany({ where: { id: o.candidateId, tenantId: o.tenantId } }));
  });

  // Retained intentionally, and free of personal data.
  await logAudit({
    tenantId: o.tenantId,
    actorType: 'user',
    actorId: o.actorId,
    action: 'candidate.erased',
    entityType: 'Candidate',
    entityId: o.candidateId,
    after: { reason: o.reason, deleted },
  });
  logger.info({ candidateId: o.candidateId, deleted }, 'Candidate data erased');

  return { candidateId: o.candidateId, deleted, erasedAt: new Date().toISOString() };
}

/**
 * Delete artifacts whose retention window has passed (storage limitation).
 * Returns the number removed. Safe to run repeatedly.
 */
export async function purgeExpiredArtifacts(now = new Date()): Promise<number> {
  // retentionDays is per-artifact; SQLite cannot express "createdAt + n days"
  // in a filter, so page through candidates for expiry and check in code.
  const cutoffCandidates = await prisma.artifact.findMany({
    where: { retentionDays: { gt: 0 } },
    select: { id: true, createdAt: true, retentionDays: true },
  });
  const expired = cutoffCandidates
    .filter((a) => a.createdAt.getTime() + a.retentionDays * 86_400_000 <= now.getTime())
    .map((a) => a.id);
  if (!expired.length) return 0;

  const { count } = await prisma.artifact.deleteMany({ where: { id: { in: expired } } });
  logger.info({ count }, 'Purged artifacts past their retention window');
  return count;
}

/** Start the daily retention sweep. Returns a stop function. */
export function startRetentionSweep(intervalMs = 24 * 60 * 60_000): () => void {
  const tick = () => {
    purgeExpiredArtifacts().catch((e) => logger.error({ err: String(e) }, 'Retention sweep failed'));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
