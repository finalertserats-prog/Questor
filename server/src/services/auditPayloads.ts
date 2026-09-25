import { Prisma } from '@prisma/client';
import { linkedinSlug, redactHandlesOnly, type ContactIdentity } from './identityRedaction.js';

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
 * The strings the content net looks for.
 *
 * CASE USED TO BE A REAL LIMIT HERE. Prisma's `contains` is case-sensitive on
 * Postgres, and `mode: 'insensitive'` is unavailable to us because the client
 * is generated for a `sqlite` datasource — so an address stored lower-cased
 * would not match the mixed-case spelling a person actually typed at signup,
 * which is the exact false negative this net exists to prevent. Emitting case
 * variants covered some of it and not the ordinary mixed-case form.
 *
 * The match is therefore done in SQL with `lower()`, which both engines have
 * and which services/userEmail.ts already uses for the same problem. See
 * `auditIdsMatchingHandles`.
 */
function contentNeedles(handles: IdentityHandles): readonly string[] {
  return [...new Set(
    [handles.email, handles.emailNormalized, linkedinSlug(handles.linkedinUrl)]
      .map((h) => h.trim())
      .filter((h) => h.length > 0),
  )];
}

/**
 * `%` and `_` are LIKE wildcards and an address may contain either — an
 * unescaped `_` would match any character and quietly widen the net onto
 * somebody else's payload.
 */
const LIKE_ESCAPE = '!';
const likeLiteral = (value: string): string =>
  `%${value.toLowerCase().replace(/[!%_]/g, (c) => `${LIKE_ESCAPE}${c}`)}%`;

/**
 * Audit rows in this tenant whose payload mentions one of these handles,
 * whatever case it was written in.
 *
 * Raw SELECT, typed UPDATE: the read needs `lower()` on both sides, which no
 * portable Prisma filter expresses, but the write stays in Prisma so the
 * marker logic lives in one place and nothing is interpolated into a statement
 * that changes data.
 */
async function auditIdsMatchingHandles(
  tx: Prisma.TransactionClient,
  tenantId: string,
  needles: readonly string[],
): Promise<readonly string[]> {
  if (needles.length === 0) return [];
  // One statement rather than one per handle: each of these is a scan of the
  // tenant's audit rows, and this runs inside the erasure transaction, where
  // every extra scan is time a subject request spends closer to timing out.
  const clauses = needles.map((needle) => {
    const like = likeLiteral(needle);
    return Prisma.sql`(lower("beforeJson") LIKE ${like} ESCAPE '!' OR lower("afterJson") LIKE ${like} ESCAPE '!')`;
  });
  const found = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AuditEvent"
    WHERE "tenantId" = ${tenantId} AND (${Prisma.join(clauses, ' OR ')})
  `;
  return [...new Set(found.map((row) => row.id))];
}

/**
 * The entity types whose audit rows belong to many candidates at once.
 *
 * Kept here beside `auditableEntityIds`, which deliberately leaves them out.
 */
const SHARED_ENTITY_TYPES = ['CandidateImportBatch', 'CalibrationAdjustment', 'CalibrationAnchorProposal'] as const;

/**
 * The entities whose audit rows belong to one candidate and nobody else.
 *
 * Deliberately NOT here: `CandidateImportBatch`, `CalibrationAdjustment` and
 * `CalibrationAnchorProposal`. One batch holds many candidates and one
 * calibration spans many people's assessments, so clearing those rows because
 * a single person was erased would destroy the audit detail for everyone else
 * in them — harm done to people who asked for nothing. That reasoning holds
 * for anonymisation too: the exclusion is about third-party harm, not about a
 * timer being weaker than a request.
 *
 * Each was then traced, because leaving them out is only defensible while they
 * carry nothing about an individual:
 *
 *   - `CandidateImportBatch` is safe and provably so. `candidate_import
 *     .started` audits `{ roleId }`; `candidate_import.confirmed` audits three
 *     integers. The names and the per-row failure messages go to the HTTP
 *     response, never to a payload, and `CandidateImportRow.readError` reaches
 *     no audit call anywhere. Pinned by a test in auditPayloadsStayClean, because
 *     it is safe by construction rather than by schema.
 *   - `CalibrationAdjustment` is safe on the automatic path. `decision.reason`
 *     is a nine-value enum and `decision.statement` a template over integers
 *     and dates, from domain/calibration.ts, which touches no database.
 *   - `CalibrationAnchorProposal`, and the `themes` on an activated adjustment,
 *     are NOT provably safe, and are this area's one named residual. An anchor
 *     is a model-written phrase of at most eighty characters that must
 *     generalise over at least three candidates' reviews by at least three
 *     reviewers, built from `CalibrationObservation.reasonText` — reviewer
 *     prose checked for protected-characteristic language and NOT for names. A
 *     contact detail can no longer survive into one (calibrationAggregate.ts
 *     rejects it on the way in). A name still could, because no code can find
 *     a name in a free-text phrase. The other half is `opts.reason` on a
 *     calibration or anchor decision: two thousand characters an approver
 *     types, unvalidated.
 *
 * WHAT THIS SWEEP DOES AND DOES NOT DO ABOUT THAT. The unique handles ARE
 * removed from these rows — see `redactHandlesFromSharedAuditPayloads`. An
 * address, a phone number or a profile slug belongs to exactly one person, so
 * taking it out of a shared row costs nobody anything. An earlier version of
 * this comment said nothing could be done here, and that was too strong.
 *
 * The NAME is not removed, and that is a judgement rather than an omission.
 * The form a name takes in these fields is usually a fragment — "the Sharma
 * interview", "Priya's answers" — so catching it means matching name PARTS.
 *
 * WHO ABSORBS THE OVER-REDACTION. This is the whole argument, and it is the
 * reason this file and identityRedaction.ts reach opposite conclusions about
 * the same technique without contradicting each other.
 *
 * Matching name parts always over-redacts: a candidate called Will or Grace
 * loses that word wherever it appears. In a TRANSCRIPT that cost is contained
 * inside that one person's own record — their interview, nobody else's — so
 * identityRedaction.ts accepts it deliberately, because the alternative is
 * leaving the person in data we are keeping for ever. In a row SHARED by many
 * candidates the identical cost lands on people who asked for nothing:
 * "grace under pressure" stops making sense in a calibration theme that
 * dozens of reviewers read, to satisfy one candidate's timer. Same technique,
 * same over-redaction, different victim — and that is what decides it.
 *
 * Matching only the exact full name would avoid that damage, and it was
 * tempting. It is refused because it catches the LEAST common form: it buys a
 * partial result while making the corpus look name-clean, which is worse than
 * a stated gap. Better a residual that says "handles are removed, names are
 * not" than a mechanism that removes some names and invites the claim that it
 * removes names.
 *
 * The real fix is upstream, where the name is allowed in: these rows are
 * aggregates over many people, so a name reaching one is a defect in the
 * calibration pipeline, not something a sweep can repair afterwards.
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
  const matched = o.handles
    ? await auditIdsMatchingHandles(tx, o.tenantId, contentNeedles(o.handles))
    : [];
  if (o.entityIds.length === 0 && matched.length === 0) return 0;

  const marker = payloadRemoved(o.removedBy ?? 'erasure');
  const mine: Prisma.AuditEventWhereInput = {
    tenantId: o.tenantId,
    // Shared rows are never CLEARED, however they were found. The content net
    // matches a payload that mentions this person, and a calibration theme or
    // an import batch that mentions them is still a record of everybody else
    // in it — emptying it to remove one person is the precise harm the
    // exclusion above exists to prevent, and without this line the second net
    // would walk straight past it and do exactly that. Their handles are taken
    // out instead, by `redactHandlesFromSharedAuditPayloads`.
    NOT: { entityType: { in: [...SHARED_ENTITY_TYPES] } },
    OR: [{ entityId: { in: [...o.entityIds] } }, { id: { in: [...matched] } }],
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


/**
 * Take this candidate's unique handles out of the audit payloads on rows that
 * are not theirs alone.
 *
 * WHY THIS IS NOT THE SAME AS CLEARING. A review made the point and it was
 * right: "leave shared rows alone entirely" was too strong. Clearing a row
 * shared by many candidates destroys everybody's record to satisfy one
 * person's timer — that part stands. But removing an address, a phone number
 * or a profile slug takes nothing from anyone else, because a handle belongs
 * to exactly one person. A calibration theme that mentioned somebody's email
 * was defective before this ran and is only improved by losing it.
 *
 * HANDLES ONLY, AND NOT THE NAME. A name is not unique and the form it takes
 * in these fields is usually a fragment — "the Sharma interview", "Priya's
 * answers" — so catching it means matching name parts, and matching name parts
 * in shared text mangles everyone else's record ("grace under pressure" is not
 * a candidate called Grace). The residual is stated on `auditableEntityIds`,
 * and it now reads "handles are removed, names are not", which is true, rather
 * than "nothing can be done here", which was not.
 */
export async function redactHandlesFromSharedAuditPayloads(
  tx: Prisma.TransactionClient,
  o: { readonly tenantId: string; readonly contact: ContactIdentity },
): Promise<number> {
  // Every shared row in the tenant, not the ones the SQL net matched. That net
  // looks for an address or a profile slug; a payload holding only a phone
  // number, whose formatting the stored spelling rarely matches, would be
  // missed by it and is exactly what the redaction below can handle. These rows
  // are few — a calibration adjustment exists per role, competency and band,
  // and import batches expire — so reading them is cheaper than the coverage
  // it would cost to narrow.
  const rows = await tx.auditEvent.findMany({
    where: { tenantId: o.tenantId, entityType: { in: [...SHARED_ENTITY_TYPES] } },
    select: { id: true, beforeJson: true, afterJson: true },
  });

  let changed = 0;
  for (const row of rows) {
    const beforeJson = redactHandlesOnly(row.beforeJson, o.contact);
    const afterJson = redactHandlesOnly(row.afterJson, o.contact);
    if (beforeJson === row.beforeJson && afterJson === row.afterJson) continue;
    await tx.auditEvent.update({ where: { id: row.id }, data: { beforeJson, afterJson } });
    changed += 1;
  }
  return changed;
}
