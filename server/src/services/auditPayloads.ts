import { Prisma } from '@prisma/client';
import { redactReferences, redactUniqueHandles, slugSpellingsForSearch, type UniqueHandles } from './identityRedaction.js';

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
 * ONE CONSEQUENCE WORTH KNOWING: anything that reads state back OUT of an
 * audit payload stops working for a cleared row. `routes/assessments.ts` finds
 * a prior review by matching its id inside `afterJson`, so a retried submit on
 * an anonymised candidate would write a second decision row rather than
 * recognising the first. Reachable only through anonymisation — erasure
 * deletes the assessment — and only for an interview a year past its decision.
 * The answer is for that check to read a column rather than a log, not for
 * this to keep the payload.
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
 * The strings the content net looks for.
 *
 * CASE USED TO BE A REAL LIMIT HERE. Prisma's `contains` is case-sensitive on
 * Postgres, so an address stored lower-cased would not match the mixed-case
 * spelling a person actually typed at signup — the exact false negative this
 * net exists to prevent. Emitting case variants covered the two ends and
 * missed the ordinary mixed-case form in between.
 *
 * `mode: 'insensitive'` is not the way out. The client this code compiles
 * against is generated from prisma/schema.prisma, whose datasource is
 * `sqlite`, so the option is not in the generated types at all — and writing
 * against an option that exists only when someone generates from the Postgres
 * schema would be a filter that compiles in one deployment and not another.
 *
 * The match is therefore done in SQL with `lower()`, which both engines have,
 * which is portable whichever schema generated the client, and which
 * services/userEmail.ts already uses for the same problem. See
 * `auditIdsMatchingHandles`.
 */
function contentNeedles(handles: UniqueHandles, references: readonly string[]): readonly string[] {
  return [...new Set([
    ...[handles.email, handles.emailNormalized].map((h) => h.trim()),
    ...slugSpellingsForSearch(handles.linkedinUrl),
    // The ids too, or a row whose only trace of this candidate is a reference
    // to one of their rows is never selected. That is how the reuse mapping
    // survived: the row carried no address, only an id.
    ...references,
  ].filter((h) => h.length > 0))];
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
 * removed from these rows — see `redactHandlesFromUnownedAuditPayloads`. An
 * address or a profile slug belongs to exactly one person, so taking it out of
 * a shared row costs nobody anything. The PHONE is not in that set — a number
 * can be a household's or an agency switchboard, so removing it would damage
 * another candidate's row; see `UniqueHandles`. An earlier version of
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
    readonly removedBy?: PayloadRemovedBy;
  },
): Promise<number> {
  if (o.entityIds.length === 0) return 0;
  const marker = payloadRemoved(o.removedBy ?? 'erasure');

  // ONLY rows whose entity is this candidate's. A content match is NOT proof
  // of ownership, and clearing on one was a live defect: candidate B's own
  // HumanReview audit row, whose payload happened to read "compared with
  // priya.sharma@example.com, this answer was stronger", had its whole payload
  // emptied when Priya was erased. That is the same harm as gutting a shared
  // row — a record destroyed for somebody who asked for nothing — one entity
  // type outside the list that was guarding against it.
  //
  // So the rule is ownership, not resemblance. A row is this candidate's when
  // an id says so, and then the payload goes. When only the CONTENT matches,
  // the honest operation is to take out the handle and leave the rest, which
  // is `redactHandlesFromUnownedAuditPayloads`.
  const mine: Prisma.AuditEventWhereInput = {
    tenantId: o.tenantId,
    entityId: { in: [...o.entityIds] },
    // Belt and braces. `auditableEntityIds` never returns a shared entity's id,
    // so this cannot match today; it is here so that a future edit which widens
    // that function cannot quietly start clearing rows belonging to many people.
    NOT: { entityType: { in: [...SHARED_ENTITY_TYPES] } },
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
 * Take this candidate's unique handles out of every audit payload that mentions
 * them but is NOT provably theirs.
 *
 * Two kinds of row land here, and they get the same treatment because the same
 * thing is true of both — we cannot say the row belongs to this candidate:
 *
 *   - rows on a SHARED entity (a calibration adjustment, an import batch), which
 *     are about many people by construction;
 *   - rows matched only because their payload mentions this person, which may
 *     as easily be somebody else's record referring to them.
 *
 * Their ids go as well as their handles. A primary key belongs to exactly one
 * row, so removing it costs the record only the link — and a surviving link is
 * how one anonymised application still pointed at a named one. See
 * `redactReferences`.
 *
 * Clearing either would destroy a record belonging to someone who asked for
 * nothing. Taking out an address or a profile slug does not: nobody else has
 * one. That is the whole justification, and it is why `UniqueHandles` excludes
 * the phone — a number can be a household's or an agency's switchboard, and
 * removing it from another candidate's row is the very harm this rule prevents.
 *
 * The name is not removed either. See the argument beside `auditableEntityIds`.
 */
export async function redactHandlesFromUnownedAuditPayloads(
  tx: Prisma.TransactionClient,
  o: {
    readonly tenantId: string;
    readonly handles: UniqueHandles;
    /** Rows already cleared by ownership, which must not be redacted on top. */
    readonly ownedEntityIds: readonly string[];
    /** The ids whose presence in someone else's row is a link back to a name. */
    readonly references: readonly string[];
  },
): Promise<number> {
  const matched = await auditIdsMatchingHandles(tx, o.tenantId, contentNeedles(o.handles, o.references));
  if (matched.length === 0) return 0;

  // Only rows the content net found. With the phone out of `UniqueHandles`
  // there is nothing this pass can remove that the net cannot find, so it no
  // longer reads every shared row in the tenant — which also takes a full scan
  // out of a transaction that has had timeout trouble before.
  const rows = await tx.auditEvent.findMany({
    where: {
      tenantId: o.tenantId,
      id: { in: [...matched] },
      NOT: { entityId: { in: [...o.ownedEntityIds] } },
    },
    select: { id: true, beforeJson: true, afterJson: true },
  });

  let changed = 0;
  for (const row of rows) {
    const beforeJson = redactReferences(redactUniqueHandles(row.beforeJson, o.handles), o.references);
    const afterJson = redactReferences(redactUniqueHandles(row.afterJson, o.handles), o.references);
    if (beforeJson === row.beforeJson && afterJson === row.afterJson) continue;
    await tx.auditEvent.update({ where: { id: row.id }, data: { beforeJson, afterJson } });
    changed += 1;
  }
  return changed;
}
