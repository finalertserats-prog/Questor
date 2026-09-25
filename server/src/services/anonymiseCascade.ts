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
  // consentJson carries the candidate's own words: an accommodation request is
  // free text they typed, and can be as identifying as anything in the
  // transcript.
  count('sessions', await scrub(asTextRows(tx.interviewSession), { where: { id: sessions }, fields: ['consentJson'], identity }));
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
  o: {
    readonly candidateId: string;
    readonly tenantId: string;
    readonly identity: KnownIdentity;
    readonly sessionIds: readonly string[];
    readonly now: Date;
  },
  count: AnonymiseCounter,
): Promise<void> {
  // A row written before emailNormalized existed may still hold the default, so
  // fall back to normalising the address the same way every write path does —
  // otherwise the staged import rows for this person are matched on a spelling
  // that is not the one stored, and quietly survive.
  const emailNormalized = o.identity.emailNormalized || normalizeEmail(o.identity.email);
  await deleteUnanonymisable(tx, { ...o, emailNormalized }, count);
  // Scrubbing runs second: the deletes above remove whole rows, so there is no
  // point redacting text that is about to cease to exist.
  await scrubEverythingKept(tx, o, count);

  // Last, so that if anything above fails the transaction rolls back with the
  // candidate still named — a half-anonymised person is worse than an
  // un-anonymised one, because nothing afterwards would know to finish the job.
  await tx.candidate.update({
    where: { id: o.candidateId },
    data: {
      fullName: ANONYMOUS_NAME,
      email: '',
      emailNormalized: '',
      phone: '',
      linkedinUrl: '',
      anonymisedAt: o.now,
    },
  });
  count('candidates', 1);
}
