import type { Prisma } from '@prisma/client';
import { redactIdentity, type KnownIdentity } from './identityRedaction.js';
import { eraseStagedImportRows } from './candidateImport.js';
import { observationModelRef } from './observerQuotes.js';
import { normalizeEmail } from './userEmail.js';

/**
 * The per-candidate work of anonymisation: everything that has to change so
 * that one person is no longer in the data, while their interviews are.
 *
 * Kept beside anonymise.ts rather than inside it for the reason
 * observerRetention.ts is kept beside dataRights.ts — that file stays readable
 * and stays under the size limit.
 *
 * The table ordering here is deliberately the same shape as
 * dataRights.ts `deleteSessionCascade`, and for the same reason: that function
 * is the oracle for "which tables hold a candidate". A table added to erasure
 * and forgotten here is how a person survives their own anonymisation.
 *
 * TWO KINDS OF WORK, and the distinction is the design:
 *
 *   DELETE — things that cannot be anonymised, or that are a route back. A CV
 *     is dates, employers, schools and addresses; scrubbing the name off it
 *     leaves a document that identifies its author to anyone who reads it. An
 *     ATS link is a foreign key into a named record in somebody else's system.
 *     An invitation, a verification token or a certificate reference is an
 *     identifier the candidate is holding, outside this database, which pairs
 *     with a row inside it. Each of those is a mapping table wearing a
 *     different hat, and a mapping table is the thing that turns anonymisation
 *     back into pseudonymisation.
 *
 *   SCRUB — free text worth keeping, with the identifiers we hold removed from
 *     it. The transcript, the scores, the competency reads and the reviewers'
 *     reasoning are the asset; they survive, minus the person.
 */

/** What an anonymised candidate is called. Says what happened; names nobody. */
export const ANONYMOUS_NAME = 'Anonymised candidate';

export type AnonymiseCounter = (label: string, count: number) => void;

/**
 * Proof that the DATABASE, not this file's statement ordering, decided this
 * candidate may be anonymised.
 *
 * The brand below is module-private, so no other file can construct one of
 * these. The only way to hold a claim is to have called
 * `claimCandidateForAnonymisation`, which asks the question as part of a
 * write. `anonymiseCandidateData` takes a claim, so there is no path to the
 * destructive work that skipped the check — an edit that tried would not
 * compile. A guard you have to remember to call is a guard somebody will one
 * day not call.
 */
declare const claimBrand: unique symbol;

export interface ClaimedCandidate {
  readonly [claimBrand]: true;
  readonly candidateId: string;
  readonly tenantId: string;
  /** Read back inside the claiming transaction, so it is what will be removed. */
  readonly identity: KnownIdentity;
  readonly sessionIds: readonly string[];
  readonly claimedAt: Date;
}

/**
 * Take this candidate for anonymisation, if the database still agrees they are
 * eligible at the moment of writing.
 *
 * WHY THIS IS AN UPDATE AND NOT A SELECT. A legal hold can be placed at any
 * instant, including between a check and the deletes that follow it. Re-reading
 * the hold inside the transaction narrows that window but does not close it:
 * the read still happens before the destructive statements, and nothing stops
 * an administrator committing a hold in between. Putting the whole eligibility
 * predicate into the WHERE clause of the first write makes the database
 * evaluate it as part of changing a row, and `count !== 1` means somebody got
 * there first — a hold arrived, the window reopened, or another run claimed it.
 *
 * Setting `anonymisedAt` here rather than at the end is what makes this a
 * claim. It is also the idempotency guard: `eligible` requires
 * `anonymisedAt: null`, so a second run over the same candidate matches
 * nothing. The whole cascade is one transaction, so a failure after this point
 * rolls the claim back with everything else — there is no state where a
 * candidate is marked anonymised but still named.
 */
export async function claimCandidateForAnonymisation(
  tx: Prisma.TransactionClient,
  o: { readonly candidateId: string; readonly now: Date; readonly eligible: Prisma.CandidateWhereInput },
): Promise<ClaimedCandidate | null> {
  const taken = await tx.candidate.updateMany({
    where: { AND: [{ id: o.candidateId }, o.eligible] },
    data: { anonymisedAt: o.now },
  });
  if (taken.count !== 1) return null;

  const row = await tx.candidate.findUniqueOrThrow({
    where: { id: o.candidateId },
    select: {
      id: true, tenantId: true, fullName: true, email: true,
      emailNormalized: true, phone: true, linkedinUrl: true,
      interviews: { select: { id: true } },
    },
  });
  // The one cast in this file, and it is the branding idiom: the symbol key
  // cannot be written by hand, which is exactly the property being bought.
  return {
    candidateId: row.id,
    tenantId: row.tenantId,
    identity: {
      fullName: row.fullName,
      email: row.email,
      emailNormalized: row.emailNormalized,
      phone: row.phone,
      linkedinUrl: row.linkedinUrl,
    },
    sessionIds: row.interviews.map((s) => s.id),
    claimedAt: o.now,
  } as unknown as ClaimedCandidate;
}

/**
 * The narrow slice of a Prisma delegate this file needs. Every model scrubbed
 * below has a string `id` and string columns, so one shape covers all of them;
 * the per-model generated types differ only in ways that do not matter here.
 */
interface TextRows {
  findMany(args: { readonly where: object; readonly select: Record<string, true> }): Promise<Record<string, unknown>[]>;
  update(args: { readonly where: { readonly id: string }; readonly data: Record<string, string> }): Promise<unknown>;
}

/**
 * Read, redact, write back — and only write rows that actually changed.
 *
 * Prisma cannot express "replace this pattern" in an UPDATE, and neither SQLite
 * nor Postgres would agree on the regex if it could, so the substitution
 * happens in code. Every statement runs on the caller's `tx`: a run that failed
 * half way through, leaving a transcript scrubbed and a candidate still named,
 * is the one outcome worse than not having run at all.
 */
async function scrub(
  rows: TextRows,
  o: { readonly where: object; readonly fields: readonly string[]; readonly identity: KnownIdentity },
): Promise<number> {
  const select = o.fields.reduce<Record<string, true>>((s, f) => ({ ...s, [f]: true }), { id: true });
  const found = await rows.findMany({ where: o.where, select });

  let changed = 0;
  for (const row of found) {
    const data = o.fields.reduce<Record<string, string>>((into, field) => {
      const value = row[field];
      // Nullable columns come back as null, and a column that is not text is
      // not ours to touch.
      if (typeof value !== 'string') return into;
      const redacted = redactIdentity(value, o.identity);
      return redacted === value ? into : { ...into, [field]: redacted };
    }, {});
    if (Object.keys(data).length === 0) continue;
    await rows.update({ where: { id: String(row.id) }, data });
    changed += 1;
  }
  return changed;
}

const asTextRows = (delegate: unknown): TextRows => delegate as TextRows;

/**
 * What is left in an audit payload once the person is removed from it.
 *
 * A marker rather than an empty string, because "" is the column's default and
 * already means "this action recorded no payload". An audit trail whose own
 * history you cannot read straight is worth less than one that says plainly
 * where something was taken out.
 */
export const AUDIT_PAYLOAD_REMOVED = '{"removed":"anonymisation"}';

/**
 * Every entity id an audit row about this candidate could be filed under.
 *
 * `AuditEvent` has no foreign keys — it is found by `entityId`, the id of the
 * thing the action was about — so this has to be assembled by hand, and it has
 * to be assembled BEFORE the deletes run, because most of these rows are about
 * to stop existing.
 *
 * The seven entity types here are the candidate-related ones actually passed to
 * `logAudit` anywhere in the server. Catching them by ENTITY rather than by an
 * allow-list of action names is the point: `identity.code_send_failed` files a
 * raw SMTP rejection under the session id, and an SMTP rejection routinely
 * quotes the address it bounced — a leak nobody would find by reading the call
 * site, and one an action list would have missed.
 *
 * Two kinds of row are deliberately out of scope.
 *
 * `CandidateImportBatch`: a batch holds many people, and clearing its history
 * because one of them aged out would destroy the record of an import that
 * concerns others who are still here. If a batch's payload really does carry
 * this person's address, the content pass catches it on its own merits.
 *
 * `CalibrationAdjustment` and `CalibrationAnchorProposal`: their payloads carry
 * prose — a reason, a statement, anchor sentences — that can be drawn from real
 * interviews, but the rows are cross-candidate aggregates, not this person's
 * history, and they are built by code that strips identity on the way in. One
 * candidate ageing out is not a reason to gut a calibration record covering
 * everyone. Again, the content pass still reaches them if this person's address
 * actually appears.
 */
export async function auditableEntityIds(
  tx: Prisma.TransactionClient,
  o: { readonly candidateId: string; readonly sessionIds: readonly string[] },
): Promise<string[]> {
  const sessions = { in: [...o.sessionIds] };
  const [assessments, pipelines, observations, awards, smeReviews] = await Promise.all([
    tx.assessmentVersion.findMany({ where: { sessionId: sessions }, select: { id: true } }),
    tx.candidatePipeline.findMany({ where: { candidateId: o.candidateId }, select: { id: true } }),
    tx.roundObservation.findMany({ where: { candidateId: o.candidateId }, select: { id: true } }),
    tx.candidateAward.findMany({ where: { candidateId: o.candidateId }, select: { id: true } }),
    tx.smeReview.findMany({ where: { candidateId: o.candidateId }, select: { id: true } }),
  ]);
  const ids = [assessments, pipelines, observations, awards, smeReviews].flat().map((r) => r.id);
  return [...new Set([o.candidateId, ...o.sessionIds, ...ids])];
}

/**
 * Take the person out of their own audit history.
 *
 * THE PROBLEM. `AuditEvent` is the one table deliberately exempt from erasure
 * and from the retention sweep (see the header of dataRights.ts): you cannot
 * demonstrate compliance with a deletion obligation whose record you also
 * deleted. But `beforeJson` and `afterJson` are `JSON.stringify` of whatever
 * the calling code passed, and for a candidate that includes the name, the
 * address and the phone written at creation, at import and at every profile
 * update — all filed under `entityId = candidateId`. Left alone, the sweep
 * severs the person from the interview and leaves a row beside it saying who
 * they were. That is the same mapping table as the ATS link, in the one place
 * the design had exempted from being looked at.
 *
 * THE DECISION, and what it costs. The payloads go entirely; the rows stay.
 * An audit trail's job is to record that an actor did a thing to an entity at a
 * time, and all four of those are COLUMNS — `actorId`, `action`, `entityType`,
 * `entityId`, `createdAt` — every one of which survives untouched. The payload
 * is corroborating detail, and for this candidate it is detail we can no longer
 * safely keep.
 *
 * Redacting the payloads instead was the obvious answer and it is not good
 * enough. Redaction removes the identifiers we HOLD; these payloads carry
 * things we do not hold and cannot pattern-match — most sharply a candidate's
 * free-text accommodation request, which the product's own code says may
 * describe a health condition, written verbatim into `afterJson`. We cannot
 * enumerate what is in every payload ever written, and a new audited action
 * added next year would leak without anyone noticing. Removing what we cannot
 * inspect is the only version of this that stays true as the code changes.
 *
 * What is lost is an echo, not the fact. The primary record of what happened
 * lives in the domain tables and anonymisation preserves it: the pipeline still
 * says it was rejected at Gold, the assessment still holds its scores, the
 * round still holds its shape. What is gone is the audit log's second copy of
 * the detail, for one person, twelve months on.
 *
 * Exported alongside `auditableEntityIds` because erasure has the same hole and
 * worse: `eraseCandidate` deletes the person but leaves their audit payloads,
 * so a candidate who exercised their right to erasure still has their
 * accommodation request sitting in `afterJson`. Fixing that is a three-line
 * call from dataRights.ts and is not this lane's to make.
 */
export async function clearAuditPayloads(
  tx: Prisma.TransactionClient,
  o: { readonly tenantId: string; readonly identity: KnownIdentity; readonly entityIds: readonly string[] },
  count: AnonymiseCounter,
): Promise<void> {
  // A second net under the first. The id pass above is exhaustive for rows
  // filed against something of this candidate's; this catches a row filed
  // against something we could not enumerate whose payload nonetheless holds
  // the person.
  //
  // It matches on the ADDRESS and the LinkedIn URL only, never the name. A name
  // is not unique — two people called Priya Sharma in one organisation is
  // ordinary — and clearing the audit history of a namesake who is still here,
  // still in a live process, would be a real loss inflicted on the wrong
  // person. The address is this system's own key for "the same human being".
  const handles = [o.identity.email, o.identity.emailNormalized, o.identity.linkedinUrl]
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  const contains = handles.flatMap((handle) => [
    { beforeJson: { contains: handle } },
    { afterJson: { contains: handle } },
  ]);

  const mine: Prisma.AuditEventWhereInput = {
    tenantId: o.tenantId,
    OR: [{ entityId: { in: [...o.entityIds] } }, ...contains],
  };

  // Two statements, so a row that never had a `before` is not given one. The
  // marker means "something was taken out here"; an empty column means "this
  // action never recorded anything", and conflating them would make the audit
  // log lie about itself in a new way while fixing the old one.
  count('auditBefore', (await tx.auditEvent.updateMany({
    where: { AND: [mine, { NOT: { beforeJson: '' } }, { NOT: { beforeJson: AUDIT_PAYLOAD_REMOVED } }] },
    data: { beforeJson: AUDIT_PAYLOAD_REMOVED },
  })).count);
  count('auditAfter', (await tx.auditEvent.updateMany({
    where: { AND: [mine, { NOT: { afterJson: '' } }, { NOT: { afterJson: AUDIT_PAYLOAD_REMOVED } }] },
    data: { afterJson: AUDIT_PAYLOAD_REMOVED },
  })).count);
}

/**
 * Delete what anonymisation cannot make anonymous.
 *
 * Nothing here is a judgement that the data is worthless. It is that each of
 * these either identifies the person no matter what we overwrite, or is one
 * half of a pair whose other half the person is holding.
 */
async function deleteUnanonymisable(
  tx: Prisma.TransactionClient,
  o: { readonly candidateId: string; readonly tenantId: string; readonly emailNormalized: string; readonly sessionIds: readonly string[] },
  count: AnonymiseCounter,
): Promise<void> {
  const sessions = { in: [...o.sessionIds] };

  // The résumé, and the evidence graph built out of it. Both quote the document
  // verbatim; a CV with the name taken off still names the schools, the
  // employers and the years, which together are a person.
  const profiles = await tx.candidateProfileVersion.findMany({ where: { candidateId: o.candidateId }, select: { id: true } });
  const profileIds = profiles.map((p) => p.id);
  if (profileIds.length) {
    const nodes = await tx.evidenceNode.findMany({ where: { profileId: { in: profileIds } }, select: { id: true } });
    const nodeIds = nodes.map((n) => n.id);
    if (nodeIds.length) {
      count('evidenceEdges', (await tx.evidenceEdge.deleteMany({ where: { OR: [{ fromId: { in: nodeIds } }, { toId: { in: nodeIds } }] } })).count);
      count('evidenceNodes', (await tx.evidenceNode.deleteMany({ where: { id: { in: nodeIds } } })).count);
    }
    count('profiles', (await tx.candidateProfileVersion.deleteMany({ where: { id: { in: profileIds } } })).count);
  }

  // Stored files. `storageKey` holds the content inline — the whole CV, the
  // whole transcript, and a report whose first line is the candidate's name —
  // and `filename` is routinely "Firstname_Lastname_CV.pdf". The transcript
  // survives in Turn.text, scrubbed, which is the copy worth keeping.
  count('artifacts', (await tx.artifact.deleteMany({ where: { OR: [{ candidateId: o.candidateId }, { sessionId: sessions }] } })).count);

  // The link into the customer's own ATS. `externalCandidateId` is a foreign
  // key into a system that still holds the name, so leaving it would make
  // re-identification a single API call. This one is not a judgement call.
  count('atsLinks', (await tx.candidateAtsLink.deleteMany({ where: { candidateId: o.candidateId } })).count);

  // Badges and certificates. A certificate's whole function is to attest that
  // a NAMED person did something, and its printed reference and verification
  // token are unique identifiers the candidate is holding on paper: a surviving
  // row keyed by either is a map from that paper back to this interview. There
  // is no version of a certificate for a person who no longer exists here.
  count('awards', (await tx.candidateAward.deleteMany({ where: { candidateId: o.candidateId } })).count);

  // Credentials that still open this interview from the candidate's own inbox.
  // A link, a reminder or a one-time code that still works is the person and
  // the record pointing at each other.
  count('invitations', (await tx.invitation.deleteMany({ where: { sessionId: sessions } })).count);
  count('reminders', (await tx.invitationReminder.deleteMany({ where: { sessionId: sessions } })).count);
  count('identityCodes', (await tx.identityCodeChallenge.deleteMany({ where: { sessionId: sessions } })).count);

  // Everything written TO the candidate, or holding a token that reaches them.
  // The letter quotes them and greets them by name, and the assessment it was
  // drawn from survives, so nothing of value goes with it.
  const assessments = await tx.assessmentVersion.findMany({ where: { sessionId: sessions }, select: { id: true } });
  const assessmentIds = assessments.map((a) => a.id);
  if (assessmentIds.length) {
    count('candidateFeedback', (await tx.candidateFeedbackDelivery.deleteMany({ where: { assessmentId: { in: assessmentIds } } })).count);
  }
  count('feedbackEmails', (await tx.candidateFeedbackEmail.deleteMany({ where: { candidateId: o.candidateId } })).count);
  count('feedbackOptIns', (await tx.candidateFeedbackOptIn.deleteMany({ where: { candidateId: o.candidateId } })).count);
  count('feedbackOptInRequests', (await tx.candidateFeedbackOptInRequest.deleteMany({ where: { candidateId: o.candidateId } })).count);
  count('humanRequests', (await tx.candidateHumanRequest.deleteMany({ where: { candidateId: o.candidateId } })).count);

  // Staged bulk-import rows: name, address, phone and the raw CV text, for a
  // person who by now exists as a candidate. Matched by address as well as by
  // id, exactly as erasure does, because a row that never became a candidate
  // still holds the same person.
  count('importRows', (await eraseStagedImportRows(tx, { tenantId: o.tenantId, candidateId: o.candidateId, emailNormalized: o.emailNormalized })).count);
}

/**
 * The consent record, and the one field on it that redaction cannot save.
 *
 * `consentJson.accommodationRequest` is up to two thousand characters the
 * CANDIDATE typed, describing what they need in order to sit the interview.
 * The code that writes it says in as many words that it "can describe a health
 * condition", and acts on that: the request is deliberately kept out of the
 * webhook and out of the email to the hiring team. Redacting it would do
 * nothing — there is no pattern to match, because the content is whatever that
 * person chose to tell us about themselves.
 *
 * So the request is removed rather than scrubbed, and `accommodationRequestedAt`
 * is left behind. The fact that an accommodation was asked for on a date is a
 * fact about the process, which we can keep and might need; the sentences
 * describing someone's condition are about a person who no longer exists here.
 *
 * Everything else on the consent record — the disclosure wording, the version,
 * the channel, the identity check — is redacted in the ordinary way.
 */
async function scrubConsent(
  tx: Prisma.TransactionClient,
  o: { readonly sessionIds: readonly string[]; readonly identity: KnownIdentity },
): Promise<number> {
  const rows = await tx.interviewSession.findMany({
    where: { id: { in: [...o.sessionIds] } },
    select: { id: true, consentJson: true },
  });

  let changed = 0;
  for (const row of rows) {
    const withoutRequest = withoutAccommodationRequest(row.consentJson);
    const consentJson = redactIdentity(withoutRequest, o.identity);
    if (consentJson === row.consentJson) continue;
    await tx.interviewSession.update({ where: { id: row.id }, data: { consentJson } });
    changed += 1;
  }
  return changed;
}

/**
 * Drop the request, keep the date. Unparseable JSON is handed back untouched
 * for the caller to redact: a consent record we cannot read is not one to
 * rewrite blind, and the generic redaction still runs over it.
 */
function withoutAccommodationRequest(consentJson: string): string {
  if (!consentJson.includes('accommodationRequest')) return consentJson;
  try {
    const consent = JSON.parse(consentJson) as Record<string, unknown>;
    if (typeof consent.accommodationRequest !== 'string') return consentJson;
    const { accommodationRequest: _removed, ...kept } = consent;
    return JSON.stringify(kept);
  } catch {
    return consentJson;
  }
}

/**
 * Remove the identifiers we hold from every piece of free text that is worth
 * keeping. This is the half of the work that preserves the asset.
 */
async function scrubEverythingKept(
  tx: Prisma.TransactionClient,
  o: { readonly candidateId: string; readonly identity: KnownIdentity; readonly sessionIds: readonly string[] },
  count: AnonymiseCounter,
): Promise<void> {
  const { identity } = o;
  const sessions = { in: [...o.sessionIds] };

  const assessments = await tx.assessmentVersion.findMany({ where: { sessionId: sessions }, select: { id: true } });
  const assessmentIds = assessments.map((a) => a.id);
  const observations = await tx.roundObservation.findMany({ where: { candidateId: o.candidateId }, select: { id: true } });
  const observationIds = observations.map((r) => r.id);

  // Turn.text is the canonical transcript and the single most valuable thing
  // here. metaJson carries the candidate's raw typed answers beside it.
  count('turns', await scrub(asTextRows(tx.turn), { where: { sessionId: sessions }, fields: ['text', 'metaJson'], identity }));
  // The assessment quotes the candidate verbatim in its evidence spans. Those
  // quotes are the evidence the scores rest on, so they stay — minus the name.
  count('assessments', await scrub(asTextRows(tx.assessmentVersion), { where: { sessionId: sessions }, fields: ['resultJson'], identity }));
  // The plan is built from the fit score, which quotes the CV.
  count('plans', await scrub(asTextRows(tx.interviewPlanVersion), { where: { sessionId: sessions }, fields: ['planJson'], identity }));
  // consentJson needs more than redaction — see scrubConsent.
  count('sessions', await scrubConsent(tx, { sessionIds: o.sessionIds, identity }));
  // An opaque blob from the candidate's own browser. We do not control what is
  // in it, which is precisely why it gets a pass.
  count('integrityEvents', await scrub(asTextRows(tx.integrityEvent), { where: { sessionId: sessions }, fields: ['detail'], identity }));
  // A failed model call can log the opening of a reply that quotes the
  // candidate — the same reason observerRetention.ts deletes these on erasure.
  count('modelExecutions', await scrub(asTextRows(tx.modelExecution), {
    where: { sessionId: { in: [...o.sessionIds, ...observationIds.map(observationModelRef)] } },
    fields: ['paramsJson', 'safetyJson'],
    identity,
  }));

  if (assessmentIds.length) {
    const byAssessment = { assessmentId: { in: assessmentIds } };
    // Reviewers write about the candidate in prose and name them while doing it.
    count('humanReviews', await scrub(asTextRows(tx.humanReview), { where: byAssessment, fields: ['comments', 'reason', 'overridesJson', 'supersededReason'], identity }));
    // The same prose, copied into the record of how the reviewer differed.
    count('reviewDifferences', await scrub(asTextRows(tx.reviewDifference), { where: byAssessment, fields: ['reason', 'summary', 'competenciesJson'], identity }));
    // And again in the calibration record, which keeps the reviewer's own words.
    count('calibrationObservations', await scrub(asTextRows(tx.calibrationObservation), { where: byAssessment, fields: ['reasonText'], identity }));
    // A reviewer's sentence about where they read the transcript.
    count('transcriptReads', await scrub(asTextRows(tx.transcriptRead), { where: byAssessment, fields: ['attestation'], identity }));
  }

  // An expert's written reading of this person, on any role.
  count('smeReviews', await scrub(asTextRows(tx.smeReview), { where: { candidateId: o.candidateId }, fields: ['feedback'], identity }));
  // Human rounds: the interviewer's notes and the quotes they recorded. The
  // round row and its structure stay, so the pipeline still reads correctly.
  count('roundNotes', await scrub(asTextRows(tx.interviewRound), { where: { pipeline: { candidateId: o.candidateId } }, fields: ['notes', 'evidenceJson'], identity }));
  // Why a hiring decision went the way it did — free text written by HR.
  count('pipelines', await scrub(asTextRows(tx.candidatePipeline), { where: { candidateId: o.candidateId }, fields: ['decisionReason'], identity }));

  if (observationIds.length) {
    const byObservation = { id: { in: observationIds } };
    count('observations', await scrub(asTextRows(tx.roundObservation), { where: byObservation, fields: ['quotesJson', 'quotesNote'], identity }));
    // The observer's transcript of a human round — the candidate speaking.
    count('observationSegments', await scrub(asTextRows(tx.observationSegment), { where: { observationId: { in: observationIds } }, fields: ['text'], identity }));
    // The sealed join link the candidate was sent. Like an invitation, it is a
    // credential they may still hold that points at this row.
    count('observationTokens', (await tx.roundObservation.updateMany({
      where: byObservation,
      data: { candidateTokenHash: null, candidateTokenSealed: '' },
    })).count);
  }
}

/**
 * Anonymise one candidate, inside the caller's transaction.
 *
 * Nothing is written anywhere recording what the values used to be. That is not
 * an oversight to be fixed later by someone wanting a safety net: a "before"
 * value kept anywhere — a column, a shadow table, an audit payload — is a
 * mapping back to the person, and its existence is the difference between
 * anonymisation and pseudonymisation. If this is ever run on the wrong
 * candidate, the answer is a database restore, not a stored copy of the name.
 */
export async function anonymiseCandidateData(
  tx: Prisma.TransactionClient,
  claim: ClaimedCandidate,
  count: AnonymiseCounter,
): Promise<void> {
  const o = { ...claim, now: claim.claimedAt };
  // A row written before emailNormalized existed may still hold the default, so
  // fall back to normalising the address the same way every write path does —
  // otherwise the staged import rows for this person are matched on a spelling
  // that is not the one stored, and quietly survive.
  const emailNormalized = o.identity.emailNormalized || normalizeEmail(o.identity.email);
  // The candidate's own history, collected BEFORE anything is deleted: an audit
  // row is found by the id of the thing it is about, and most of those things
  // are about to stop existing.
  const history = await auditableEntityIds(tx, o);

  await deleteUnanonymisable(tx, { ...o, emailNormalized }, count);
  // Scrubbing runs second: the deletes above remove whole rows, so there is no
  // point redacting text that is about to cease to exist.
  await scrubEverythingKept(tx, o, count);
  await clearAuditPayloads(tx, { tenantId: o.tenantId, identity: o.identity, entityIds: history }, count);

  // The identity columns go last. `anonymisedAt` is already set — the claim set
  // it, which is what made this call reachable — so all that is left is the
  // person. Ordering is a readability choice, not a safety one: the whole
  // cascade is one transaction, so a failure anywhere rolls back the claim too
  // and there is no state where a row is marked anonymised but still named.
  await tx.candidate.update({
    where: { id: o.candidateId },
    data: {
      fullName: ANONYMOUS_NAME,
      email: '',
      emailNormalized: '',
      phone: '',
      linkedinUrl: '',
    },
  });
  count('candidates', 1);
}
