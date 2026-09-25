import type { Prisma } from '@prisma/client';

/**
 * Clearing what an audit row SAID about a person, while keeping the fact that
 * it happened.
 *
 * The audit trail deliberately survives erasure, and the reason is good: you
 * cannot demonstrate compliance with a deletion obligation whose record you
 * also deleted. But the justification written beside that rule claimed the
 * trail "holds no personal data itself", and that was not true.
 *
 * Two places put a person into it, and neither is obvious from its call site:
 *
 *   - `accommodation.requested` writes the candidate's own words into
 *     `afterJson` — up to two thousand characters of prose that the code two
 *     lines below it refuses to put in an email BECAUSE it can describe a
 *     health condition.
 *   - `identity.code_send_failed` writes the mail provider's error verbatim,
 *     and an SMTP rejection routinely quotes the address it refused.
 *
 * So the exemption was granted on a premise that does not hold, on the one
 * path the product offers as its strongest guarantee.
 *
 * What survives is the record: actorId, action, entityType, entityId,
 * createdAt. An audit trail's job is to say that somebody did a thing to
 * something at a time, and every one of those is a column. The payload is
 * corroborating detail, and for a person who has asked to be erased it is
 * detail we have no right to keep.
 *
 * Removal rather than redaction, deliberately. Redaction can only remove the
 * identifiers we hold and can pattern-match; these payloads carry things we do
 * not hold — the accommodation prose most sharply — and an action audited for
 * the first time next year would leak silently. Removing what we cannot
 * inspect is the only version that stays true as the code changes.
 */

/**
 * Written in place of a payload we removed.
 *
 * Not an empty string: `""` is already the default and means "this action
 * recorded no payload at all". Conflating the two would make the audit log
 * lie about itself in a new way while fixing the old one — a reader could no
 * longer tell a silent action from a cleared one.
 */
export const PAYLOAD_REMOVED = '{"removed":"erasure"}';

/**
 * The entities whose audit rows belong to one candidate and nobody else.
 *
 * Deliberately NOT here: `CandidateImportBatch`, `CalibrationAdjustment` and
 * `CalibrationAnchorProposal`. One batch holds many candidates and one
 * calibration spans many people's assessments, so clearing those rows because
 * a single person was erased would destroy the audit detail for everyone else
 * in them — harm done to people who asked for nothing. They need per-candidate
 * rows before this can reach them, which is a larger change than erasure.
 */
export async function auditableEntityIds(
  tx: Prisma.TransactionClient,
  o: { readonly tenantId: string; readonly candidateId: string; readonly sessionIds: readonly string[] },
): Promise<readonly string[]> {
  const where = { candidateId: o.candidateId } as const;
  const [pipelines, assessments, observations, awards, reviews] = await Promise.all([
    tx.candidatePipeline.findMany({ where, select: { id: true } }),
    o.sessionIds.length > 0
      ? tx.assessmentVersion.findMany({ where: { sessionId: { in: [...o.sessionIds] } }, select: { id: true } })
      : Promise.resolve([]),
    tx.roundObservation.findMany({ where: { round: { pipeline: where } }, select: { id: true } }),
    tx.candidateAward.findMany({ where, select: { id: true } }),
    tx.smeReview.findMany({ where, select: { id: true } }),
  ]);

  return [
    o.candidateId,
    ...o.sessionIds,
    ...pipelines.map((row) => row.id),
    ...assessments.map((row) => row.id),
    ...observations.map((row) => row.id),
    ...awards.map((row) => row.id),
    ...reviews.map((row) => row.id),
  ];
}

/**
 * Empty every payload on the audit rows for these entities.
 *
 * Two statements rather than one: a row that never carried a `before` is not
 * given one, so the log does not gain a payload where it never had a thought.
 *
 * Must run BEFORE the rows themselves are deleted — the ids are how these
 * audit events are found, and once the pipeline or the assessment is gone
 * there is nothing left to look them up by.
 */
export async function clearAuditPayloads(
  tx: Prisma.TransactionClient,
  o: { readonly tenantId: string; readonly entityIds: readonly string[] },
): Promise<number> {
  if (o.entityIds.length === 0) return 0;
  const ids = [...o.entityIds];

  const [before, after] = await Promise.all([
    tx.auditEvent.updateMany({
      where: { tenantId: o.tenantId, entityId: { in: ids }, NOT: { beforeJson: '' } },
      data: { beforeJson: PAYLOAD_REMOVED },
    }),
    tx.auditEvent.updateMany({
      where: { tenantId: o.tenantId, entityId: { in: ids }, NOT: { afterJson: '' } },
      data: { afterJson: PAYLOAD_REMOVED },
    }),
  ]);

  return Math.max(before.count, after.count);
}
