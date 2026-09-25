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
export type PayloadRemovedBy = 'erasure' | 'anonymisation';

export const payloadRemoved = (by: PayloadRemovedBy): string => `{"removed":"${by}"}`;

/**
 * The erasure spelling, which production and its test already use. Anonymisation
 * severs a person from a record that is KEPT, which is a different act with a
 * different justification, and a reader of the log should be able to tell which
 * one emptied a payload.
 */
export const PAYLOAD_REMOVED = payloadRemoved('erasure');

/**
 * The identifiers the content net is allowed to match on.
 *
 * A deliberately narrow type, and the narrowness is the point: it CANNOT carry
 * the name. A name is not unique — two people called Priya Sharma in one
 * organisation is ordinary — and clearing the audit history of a namesake who
 * is still here, still in a live process, would be real harm done to the wrong
 * person. The address is this system's own key for "the same human being", and
 * the LinkedIn URL is a handle only one person has.
 *
 * Expressed as a type rather than as a comment because the rule has to survive
 * the next person to call this. Passing a `Candidate` row wholesale, and
 * quietly widening the net to the name with it, will not compile.
 */
export interface IdentityHandles {
  readonly email: string;
  readonly emailNormalized: string;
  readonly linkedinUrl: string;
}

/**
 * How little a LinkedIn URL has to change to stop matching: `http` for
 * `https`, a trailing slash, a `?utm_source=` on the end. Matching the profile
 * slug instead survives all of those, and the slug is the part that is
 * actually the person's own unique handle. Six characters minimum, so a
 * truncated slug does not become a net wide enough to catch other people.
 */
const MIN_SLUG = 6;

function linkedinSlug(url: string): string {
  const slug = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url)?.[1] ?? '';
  return slug.length >= MIN_SLUG ? slug : '';
}

/**
 * The strings the content net looks for, in the spellings a database might
 * actually hold them.
 *
 * CASE IS A REAL LIMIT HERE, not a theoretical one. Prisma's `contains` is
 * case-sensitive on Postgres, and `mode: 'insensitive'` is not available to
 * us: the datasource is declared `sqlite`, so the client is generated without
 * it. Emitting the stored spelling, the lower-cased one and the upper-cased
 * one covers what is actually seen — a mixed-case address written at signup
 * against its normalised twin — but not every casing a raw import could have
 * produced.
 *
 * That residual is why this is a BACKSTOP and the id pass is the load-bearing
 * mechanism.
 */
function contentNeedles(handles: IdentityHandles): readonly string[] {
  const raw = [handles.email, handles.emailNormalized, linkedinSlug(handles.linkedinUrl)]
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return [...new Set(raw.flatMap((h) => [h, h.toLowerCase(), h.toUpperCase()]))];
}

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
    // Direct on candidateId rather than through round -> pipeline: the column
    // exists, and an observation whose pipeline has already gone would be
    // invisible to the relation walk while its audit rows were not.
    tx.roundObservation.findMany({ where, select: { id: true } }),
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
  o: {
    readonly tenantId: string;
    readonly entityIds: readonly string[];
    /** The second net. Omit it to run the id pass alone. */
    readonly handles?: IdentityHandles;
    readonly removedBy?: PayloadRemovedBy;
  },
): Promise<number> {
  // A second net under the first. The id pass is exhaustive for rows filed
  // against something of this candidate's; this catches a row filed against
  // something we could not enumerate whose payload nonetheless holds the
  // person. `IdentityHandles` is what makes the name impossible to pass.
  const contains = (o.handles ? contentNeedles(o.handles) : []).flatMap((handle) => [
    { beforeJson: { contains: handle } },
    { afterJson: { contains: handle } },
  ]);
  if (o.entityIds.length === 0 && contains.length === 0) return 0;

  const marker = payloadRemoved(o.removedBy ?? 'erasure');
  const mine: Prisma.AuditEventWhereInput = {
    tenantId: o.tenantId,
    OR: [{ entityId: { in: [...o.entityIds] } }, ...contains],
  };

  // Two statements rather than one: a row that never carried a `before` is not
  // given one, so the log does not gain a payload where it never had a thought.
  // Each also skips rows already carrying the marker, so a re-run counts only
  // what it actually changed.
  const [before, after] = await Promise.all([
    tx.auditEvent.updateMany({
      where: { AND: [mine, { NOT: { beforeJson: '' } }, { NOT: { beforeJson: marker } }] },
      data: { beforeJson: marker },
    }),
    tx.auditEvent.updateMany({
      where: { AND: [mine, { NOT: { afterJson: '' } }, { NOT: { afterJson: marker } }] },
      data: { afterJson: marker },
    }),
  ]);

  return Math.max(before.count, after.count);
}

