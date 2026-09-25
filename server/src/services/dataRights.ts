import { Prisma } from '@prisma/client';
import { clearExpiredMeetingLinks, collectVendorMeetings, removeVendorMeetings } from './roundMeeting.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { startJob } from './jobs.js';
import { eraseStagedImportRows } from './candidateImport.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import { candidateHasHeldObservation, deleteCandidateObservations, purgeExpiredObservations } from './observerRetention.js';
import { auditableEntityIds, clearAuditPayloads } from './auditPayloads.js';

// Candidate data-rights operations.
//
// Erasure is a legal obligation, not a convenience: GDPR Art. 17 (right to
// erasure), India DPDP s.8(6)/8(9) (delete once the recruitment purpose is
// complete), and Illinois AIVIA s.20 (delete within 30 days of request,
// including copies). Storage limitation — GDPR Art. 5(1)(e), DPDP s.8(7) — is
// the same obligation on a timer: data must go once the purpose is spent, even
// if nobody asks.
//
// Retention is modelled on InterviewSession, not on Artifact. The recruitment
// purpose completes for a whole interview at once, and one interview's personal
// data is spread over Turn.text (the canonical transcript),
// AssessmentVersion.resultJson, HumanReview.comments and Artifact rows. A
// per-artifact window can only ever delete a copy while the original stays.
//
// The audit trail deliberately survives both erasure and purge: you cannot
// demonstrate compliance with a deletion obligation whose record you also
// deleted. What survives is the record — who did what to which entity, when.
//
// It used to say here that the trail "holds no personal data itself", and that
// was false. `accommodation.requested` writes the candidate's own prose into
// afterJson, which the code beside it refuses to put in an email because it can
// describe a health condition; `identity.code_send_failed` writes an SMTP
// rejection that quotes the address. So erasure now empties the payloads of a
// candidate's own audit rows before deleting them (services/auditPayloads.ts)
// and keeps the columns that make it an audit trail.

/**
 * Default retention window for interview data, in days.
 *
 * 180 days is the defensible middle for recruitment. It is long enough to cover
 * the realistic tail of a hiring process (offer, decline, backfill, re-open) and
 * to answer a discrimination complaint while the evidence still exists — US EEOC
 * record-keeping expects one year for application records, so a shorter default
 * is chosen deliberately for the interview transcript itself, which is far more
 * sensitive than the application record and is not what EEOC requires you to
 * keep. It is short enough that "we kept the recording of your interview
 * indefinitely" never becomes true, which is the failure mode GDPR Art. 5(1)(e),
 * DPDP s.8(6) and AIVIA s.20 all exist to prevent.
 *
 * Override per deployment with RETENTION_DEFAULT_DAYS. A session may also carry
 * its own `retainUntil`, which always wins over this default.
 */
export const DEFAULT_RETENTION_DAYS = 180;

/**
 * Effective default window, env-overridable. A value that is not a whole number
 * of days is ignored and said out loud.
 *
 * The round-trip check is the point: parseInt reads "2w" as 2, so a typo in a
 * deploy variable shortened the window from 180 days to two and the next sweep
 * deleted interviews nowhere near the end of their life — deletion being the one
 * thing no later fix can undo. Same reasoning as INCOMPLETE_AFTER_MINUTES in
 * services/incompleteInterviews.ts.
 */
export function retentionDays(): number {
  const configured = process.env.RETENTION_DEFAULT_DAYS;
  if (configured === undefined) return DEFAULT_RETENTION_DAYS;
  const trimmed = configured.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    logger.warn(
      { value: configured, usingDays: DEFAULT_RETENTION_DAYS },
      'RETENTION_DEFAULT_DAYS is not a positive whole number of days; ignoring it and using the default',
    );
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

const DAY_MS = 86_400_000;

/**
 * How long an erasure or a purge may hold its transaction open.
 *
 * Prisma's default is five seconds, and nothing here was overriding it. One
 * erasure walks about forty tables for a single person, and on an idle
 * database that finishes well inside the default — which is exactly why it
 * survived every green suite. Under load it does not: the transaction is
 * rolled back with P2028 and the route answers 500, leaving the candidate
 * still there and the caller told only that something failed.
 *
 * That matters more here than almost anywhere else in the product. Erasure is
 * a legal obligation with a deadline, and the person who asked for it has no
 * way to tell a refusal from a system that is merely busy. A deletion must
 * fail because it is not allowed — a hold, a tenant mismatch — never because
 * the database was having a bad minute.
 *
 * `maxWait` is raised for the same reason one step earlier: under the load
 * that makes the work slow, waiting for a free connection is also slow, and
 * the two-second default would refuse before any work began.
 *
 * Generous rather than tuned, deliberately. These run rarely, and the cost of
 * a long-held transaction is far smaller than the cost of an erasure that
 * reports failure to somebody exercising a right.
 */
const ERASURE_TX = { timeout: 120_000, maxWait: 30_000 } as const;

/** The fields needed to decide whether a session is past its window. */
interface RetentionFields {
  retainUntil: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  legalHold: boolean;
}

/**
 * When this session's data must be gone by.
 *
 * The clock starts at `completedAt` because that is when the recruitment purpose
 * is actually spent — DPDP s.8(6) ties deletion to purpose completion, not to
 * record creation. Sessions that never completed (abandoned, no-show) fall back
 * to `createdAt` so an unfinished interview cannot be retained forever by simply
 * never being closed.
 */
export function resolveRetainUntil(s: RetentionFields, days = retentionDays()): Date {
  if (s.retainUntil) return s.retainUntil;
  const anchor = s.completedAt ?? s.createdAt;
  return new Date(anchor.getTime() + days * DAY_MS);
}

type Counter = (label: string, fn: () => Promise<{ count: number }>) => Promise<void>;

function makeCounter(into: Record<string, number>): Counter {
  return async (label, fn) => {
    into[label] = (into[label] ?? 0) + (await fn()).count;
  };
}

/**
 * Delete everything hanging off a set of sessions, leaf-first, then the sessions
 * themselves. Every statement MUST go through `tx` — running these on the global
 * client would put them outside the transaction, so a failure part-way would
 * leave a half-deleted session with nothing to roll back. For a deletion
 * obligation that is the worst outcome: it looks done and isn't.
 *
 * Shared by erasure and by the retention sweep so the two paths cannot drift —
 * a table added to one ordering but not the other is exactly how personal data
 * survives a deletion that reports success.
 */
/**
 * Whose calendar holds this person's interview rounds.
 *
 * CalendarDelivery identifies its target by a type and an id rather than a
 * foreign key, because the target is one of two tables. Nothing in the database
 * therefore stops these rows outliving the round — and each one carries a
 * recipient's name and email address. Deleted explicitly, in both erasure
 * paths, and held there by a test rather than by a constraint.
 */
async function deleteRoundCalendarDeliveries(
  tx: Prisma.TransactionClient,
  candidateId: string,
  count: Counter,
): Promise<void> {
  const rounds = await tx.interviewRound.findMany({ where: { pipeline: { candidateId } }, select: { id: true } });
  if (!rounds.length) return;
  await count('calendarDeliveries', () => tx.calendarDelivery.deleteMany({
    where: { targetType: 'round', targetId: { in: rounds.map((r) => r.id) } },
  }));
}

async function deleteSessionCascade(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  count: Counter,
): Promise<void> {
  if (!sessionIds.length) return;

  // The feedback email quotes the candidate and holds foreign keys onto the
  // session and the assessment, so it goes before either.
  await count('feedbackEmails', () => tx.candidateFeedbackEmail.deleteMany({ where: { sessionId: { in: sessionIds } } }));

  // Whose calendar holds this interview. CalendarDelivery points at one of two
  // tables so it carries no foreign key, which means nothing fails loudly if
  // this line is ever lost — and the row holds an email address. A test pins
  // it (tests/calendarDeliveryErasure.test.ts) because the database will not.
  await count('calendarDeliveries', () => tx.calendarDelivery.deleteMany({
    where: { targetType: 'interview', targetId: { in: sessionIds } },
  }));

  const assessments = await tx.assessmentVersion.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true },
  });
  const assessmentIds = assessments.map((a) => a.id);

  if (assessmentIds.length) {
    // The candidate-facing feedback draft quotes the candidate verbatim, so it
    // is transcript data under another name. It also holds a required foreign
    // key onto AssessmentVersion: without this line the delete below fails the
    // constraint and the whole erasure — a legal obligation — errors out.
    await count('candidateFeedback', () => tx.candidateFeedbackDelivery.deleteMany({ where: { assessmentId: { in: assessmentIds } } }));
    // The record of how a reviewer differed from the AI keys onto the review
    // and the assessment, so it goes before both.
    await count('reviewDifferences', () => tx.reviewDifference.deleteMany({ where: { assessmentId: { in: assessmentIds } } }));
    // The calibration observations from those same reviews. They hold nothing
    // about the candidate beyond the assessment id and references to their
    // turns, but the references are to a transcript that is about to cease to
    // exist, and an erasure leaves nothing pointing at the person. Deliberately
    // no foreign key onto the assessment, so this is a plain delete that an
    // erasure can always complete rather than a constraint that could block it.
    await count('calibrationObservations', () => tx.calibrationObservation.deleteMany({ where: { assessmentId: { in: assessmentIds } } }));
    // Who read this candidate's transcript, and any sentence saying where they
    // read it. It names the candidate's interview and holds a required key onto
    // the assessment, so it goes with the rest — the audit event that the
    // reading happened survives, as consent and decision events do.
    await count('transcriptReads', () => tx.transcriptRead.deleteMany({ where: { assessmentId: { in: assessmentIds } } }));
    await count('humanReviews', () => tx.humanReview.deleteMany({ where: { assessmentId: { in: assessmentIds } } }));
    await count('assessments', () => tx.assessmentVersion.deleteMany({ where: { id: { in: assessmentIds } } }));
  }
  // A subject-matter expert's written reading of one of these interviews. It
  // goes with the interview for the same reason the human review above does:
  // once the transcript and the assessment are gone, a paragraph arguing about
  // what the candidate said in them is the only place that conversation still
  // exists, and it names the person. Rows with no `sessionId` are a reading of
  // the CV against the role rather than of an interview, and survive a session
  // purge exactly as they survive the interview never having happened.
  await count('smeReviews', () => tx.smeReview.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  // The candidate's own answer about feedback, and any request to speak to a
  // person. Both name the candidate and both hold foreign keys onto the session.
  await count('feedbackOptIns', () => tx.candidateFeedbackOptIn.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('humanRequests', () => tx.candidateHumanRequest.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('feedbackOptInRequests', () => tx.candidateFeedbackOptInRequest.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  // Turn.text is the canonical transcript — the single most sensitive record
  // here. If this line does not run, nothing else in the sweep matters.
  await count('turns', () => tx.turn.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('invitations', () => tx.invitation.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('plans', () => tx.interviewPlanVersion.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  // Which library questions the interview asked and how they went: keyed to the interview, erased with it.
  await count('libraryUsage', () => tx.libraryUsage.deleteMany({ where: { interviewSessionId: { in: sessionIds } } }));
  // Model executions record prompts/outputs that can quote the candidate.
  await count('modelExecutions', () => tx.modelExecution.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('artifacts', () => tx.artifact.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  // Browser-integrity events (tab blur, paste) key on the session; without
  // this line the foreign key blocked the session delete below, and an erasure
  // that is a legal obligation failed for any candidate who ever switched tabs.
  await count('integrityEvents', () => tx.integrityEvent.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  // One-time identity codes (hashes and when they were confirmed) belong to the session too.
  await count('identityCodes', () => tx.identityCodeChallenge.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  // A pipeline round may outlive a purged session; unlink it rather than keep a dangling reference.
  await count('roundSessionLinks', () => tx.interviewRound.updateMany({ where: { sessionId: { in: sessionIds } }, data: { sessionId: null } }));
  await count('sessions', () => tx.interviewSession.deleteMany({ where: { id: { in: sessionIds } } }));
}

/** Delete a candidate's profile versions and the evidence graph built from them. */
async function deleteProfileCascade(
  tx: Prisma.TransactionClient,
  candidateId: string,
  count: Counter,
): Promise<void> {
  const profiles = await tx.candidateProfileVersion.findMany({
    where: { candidateId },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);
  if (!profileIds.length) return;

  const nodes = await tx.evidenceNode.findMany({ where: { profileId: { in: profileIds } }, select: { id: true } });
  const nodeIds = nodes.map((n) => n.id);
  if (nodeIds.length) {
    await count('evidenceEdges', () => tx.evidenceEdge.deleteMany({
      where: { OR: [{ fromId: { in: nodeIds } }, { toId: { in: nodeIds } }] },
    }));
    await count('evidenceNodes', () => tx.evidenceNode.deleteMany({ where: { id: { in: nodeIds } } }));
  }
  // rawText is the raw résumé — personal data in its most unstructured form.
  await count('profiles', () => tx.candidateProfileVersion.deleteMany({ where: { id: { in: profileIds } } }));
}

/** Whether anything of this candidate's is under legal hold, which blocks erasure. */
export async function candidateUnderLegalHold(candidateId: string, tenantId: string): Promise<boolean> {
  const held = await prisma.interviewSession.count({
    where: { candidateId, tenantId, OR: [{ legalHold: true }, { artifacts: { some: { legalHold: true } } }] },
  });
  // Resume uploads hang off the candidate, not a session, so a hold on one was
  // invisible to the session-based check above and the file was deleted anyway.
  const heldArtifacts = await prisma.artifact.count({ where: { candidateId, tenantId, legalHold: true } });
  // An AI-observer transcript of a human round can be held on its own.
  return held > 0 || heldArtifacts > 0 || await candidateHasHeldObservation(candidateId, tenantId);
}

export interface ErasureResult {
  candidateId: string;
  deleted: Record<string, number>;
  erasedAt: string;
}

/**
 * Permanently erase one candidate and everything derived from them, in
 * dependency order. Scoped by tenant so a caller cannot erase across tenants.
 *
 * `retainUntil` is ignored — that governs the automatic sweep, not an explicit
 * instruction from an accountable operator. `legalHold` is NOT ignored: it
 * blocks erasure outright (see below). The audit record names the actor.
 */
export async function eraseCandidate(o: {
  tenantId: string;
  candidateId: string;
  actorId: string;
  reason: string;
}): Promise<ErasureResult> {
  const candidate = await prisma.candidate.findFirst({
    where: { id: o.candidateId, tenantId: o.tenantId },
    select: { id: true, emailNormalized: true },
  });
  if (!candidate) throw new Error('Candidate not found in this tenant');

  // A legal hold outranks an erasure request. GDPR Art. 17(3)(e) disapplies the
  // right to erasure where the data is needed to establish, exercise or defend
  // legal claims — which is exactly what a hold marks. Honouring the request
  // anyway would destroy the evidence the hold exists to preserve, through a
  // supported endpoint, at the request of the person the claim may concern.
  // Release the hold deliberately first if erasure is genuinely correct.
  if (await candidateUnderLegalHold(o.candidateId, o.tenantId)) {
    throw new HttpError(
      409,
      'This candidate has interview data under legal hold and cannot be erased. Release the hold first if erasure is appropriate.',
    );
  }

  const sessions = await prisma.interviewSession.findMany({
    where: { candidateId: o.candidateId, tenantId: o.tenantId },
    select: { id: true },
  });
  const sessionIds = sessions.map((s) => s.id);

  const deleted: Record<string, number> = {};
  const count = makeCounter(deleted);
  // Read inside the transaction, just before the rows go: they are the only
  // record of which vendor meetings belong to this candidate. A creation still
  // in flight finds its round gone and removes its own meeting.
  let vendorMeetings: Awaited<ReturnType<typeof collectVendorMeetings>> = [];

  await prisma.$transaction(async (tx) => {
    vendorMeetings = await collectVendorMeetings(o.candidateId, o.tenantId, tx);
    // First, while the rows that name these audit events still exist. The
    // audit trail survives erasure on purpose — a deletion you cannot show
    // you performed is not compliance — but it was surviving with the
    // candidate still inside it, which the rule beside it wrongly assumed
    // could not happen. The rows stay; what they said about the person goes.
    await count('auditPayloads', async () => ({
      count: await clearAuditPayloads(tx, {
        tenantId: o.tenantId,
        entityIds: await auditableEntityIds(tx, { tenantId: o.tenantId, candidateId: o.candidateId, sessionIds }),
      }),
    }));
    await deleteSessionCascade(tx, sessionIds, count);
    await deleteProfileCascade(tx, o.candidateId, count);
    // Artifacts attached to the candidate rather than to a session (résumé
    // uploads) are not reached by the session cascade.
    await count('artifacts', () => tx.artifact.deleteMany({ where: { candidateId: o.candidateId } }));
    // Access-control rows hold a foreign key onto Candidate, so they must go
    // first or the delete below fails the constraint and erasure — a legal
    // obligation — errors out entirely.
    await deleteCandidateObservations(tx, o.candidateId, count);
    // The interviewers seated on those rounds key onto InterviewRound, so they
    // go before it for the same reason as the observations above.
    await count('roundInterviewers', () => tx.roundInterviewer.deleteMany({ where: { round: { pipeline: { candidateId: o.candidateId } } } }));
    await deleteRoundCalendarDeliveries(tx, o.candidateId, count);
    await count('pipelineRounds', () => tx.interviewRound.deleteMany({ where: { pipeline: { candidateId: o.candidateId } } }));
    await count('pipelines', () => tx.candidatePipeline.deleteMany({ where: { candidateId: o.candidateId } }));
    await count('assignments', () => tx.candidateAssignment.deleteMany({ where: { candidateId: o.candidateId } }));
    // Every expert's written reading of this person, on any role, including the
    // ones the session cascade above could not reach because they are about the
    // CV rather than about an interview.
    //
    // SmeReview holds no foreign key onto Candidate — the model is keyed by id
    // alone — so nothing makes this line necessary for the delete below to
    // succeed, and nothing would report it missing. That is precisely why it is
    // here and why it is tested: an erasure that reports success while a
    // paragraph naming the candidate stays in the database is the worst shape
    // this obligation can fail in.
    await count('smeReviews', () => tx.smeReview.deleteMany({ where: { candidateId: o.candidateId } }));
    // Every reviewer's shortlist tick for this person, on any role. It keys on
    // Candidate, so leaving it would fail the constraint below and abort an
    // erasure that is a legal obligation.
    await count('shortlistings', () => tx.candidateShortlist.deleteMany({ where: { candidateId: o.candidateId } }));
    // The link says which ATS record this person is; it goes with them.
    await count('atsLinks', () => tx.candidateAtsLink.deleteMany({ where: { candidateId: o.candidateId } }));
    // Every badge and certificate struck for this person, on any role. The
    // frozen evidence rows name them and say what they did, so an erasure that
    // left them would leave a public verification page still answering for
    // someone Questor has been told to forget.
    await count('awards', () => tx.candidateAward.deleteMany({ where: { candidateId: o.candidateId } }));
    // Belt and braces alongside the session cascade: these rows also key on the
    // candidate, so a row whose session was already gone would otherwise block
    // the delete below.
    await count('feedbackOptIns', () => tx.candidateFeedbackOptIn.deleteMany({ where: { candidateId: o.candidateId } }));
    await count('feedbackEmails', () => tx.candidateFeedbackEmail.deleteMany({ where: { candidateId: o.candidateId } }));
    await count('humanRequests', () => tx.candidateHumanRequest.deleteMany({ where: { candidateId: o.candidateId } }));
    await count('feedbackOptInRequests', () => tx.candidateFeedbackOptInRequest.deleteMany({ where: { candidateId: o.candidateId } }));
    // Staged bulk-import rows (name, address, CV text) for the same person.
    await count('importRows', () => eraseStagedImportRows(tx, { tenantId: o.tenantId, candidateId: o.candidateId, emailNormalized: candidate.emailNormalized }));
    await count('candidates', () => tx.candidate.deleteMany({ where: { id: o.candidateId, tenantId: o.tenantId } }));
  }, ERASURE_TX);

  // After the commit, and best effort: a vendor outage must not block erasure.
  // Booked meetings for an erased candidate have no purpose left.
  if (vendorMeetings.length > 0) {
    deleted.externalMeetings = await removeVendorMeetings(vendorMeetings);
  }

  // Retained intentionally, and free of personal data: the free-text reason
  // is not stored here, because a sentence like "asked for deletion after a
  // health disclosure" would outlive the very erasure it explains.
  await logAudit({
    tenantId: o.tenantId,
    actorType: 'user',
    actorId: o.actorId,
    action: 'candidate.erased',
    entityType: 'Candidate',
    entityId: o.candidateId,
    after: { reasonProvided: o.reason.trim().length > 0, deleted },
  });
  logger.info({ candidateId: o.candidateId, deleted }, 'Candidate data erased');

  return { candidateId: o.candidateId, deleted, erasedAt: new Date().toISOString() };
}

export interface DuePurgeSession {
  sessionId: string;
  tenantId: string;
  candidateId: string;
  candidateName: string;
  state: string;
  completedAt: Date | null;
  createdAt: Date;
  retainUntil: Date;
  /** True when retainUntil came from the default window rather than the row. */
  usingDefaultWindow: boolean;
  counts: { turns: number; assessments: number; artifacts: number };
}

/**
 * Sessions whose retention window has closed. Read-only — this is what both the
 * sweep and the admin dry-run are built on, so the preview an HR admin sees is
 * produced by the same query that does the deleting and cannot disagree with it.
 *
 * Sessions under `legalHold` are excluded at the database level: a hold must be
 * impossible to lose to a later bug in the filtering below.
 */
export async function findSessionsDueForPurge(o: {
  now?: Date;
  tenantId?: string;
} = {}): Promise<DuePurgeSession[]> {
  const now = o.now ?? new Date();
  // SQLite cannot express "createdAt + n days" in a filter, so expiry is decided
  // in code. Legal hold and tenant scope are still pushed into the query.
  const sessions = await prisma.interviewSession.findMany({
    where: {
      legalHold: false,
      // A hold on any single artifact holds the whole session. The alternative —
      // purging the session but sparing that one artifact — would destroy the
      // transcript and context the held evidence only makes sense within, which
      // is not what anyone placing a hold intends.
      artifacts: { none: { legalHold: true } },
      ...(o.tenantId ? { tenantId: o.tenantId } : {}),
    },
    select: {
      id: true, tenantId: true, candidateId: true, state: true,
      retainUntil: true, completedAt: true, createdAt: true, legalHold: true,
      candidate: { select: { fullName: true } },
    },
  });

  const due = sessions.filter((s) => resolveRetainUntil(s).getTime() <= now.getTime());
  if (!due.length) return [];

  const ids = due.map((s) => s.id);
  const [turns, assessments, artifacts] = await Promise.all([
    prisma.turn.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids } }, _count: { _all: true } }),
    prisma.assessmentVersion.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids } }, _count: { _all: true } }),
    prisma.artifact.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids } }, _count: { _all: true } }),
  ]);
  const tally = (rows: { sessionId: string | null; _count: { _all: number } }[], id: string): number =>
    rows.find((r) => r.sessionId === id)?._count._all ?? 0;

  return due.map((s) => ({
    sessionId: s.id,
    tenantId: s.tenantId,
    candidateId: s.candidateId,
    candidateName: s.candidate.fullName,
    state: s.state,
    completedAt: s.completedAt,
    createdAt: s.createdAt,
    retainUntil: resolveRetainUntil(s),
    usingDefaultWindow: s.retainUntil === null,
    counts: {
      turns: tally(turns, s.id),
      assessments: tally(assessments, s.id),
      artifacts: tally(artifacts, s.id),
    },
  }));
}

export interface PurgeResult {
  sessionsPurged: number;
  candidatesPurged: number;
  artifactsPurged: number;
  /** Rows the sweep tried and failed to delete. Non-zero means data survived. */
  failed: number;
  /** Entity ids that failed, so a stuck row can be chased without guesswork. */
  failures: string[];
  deleted: Record<string, number>;
}

/**
 * Delete every session past its retention window, plus the candidate personal
 * data left with no lawful reason to exist afterwards. Safe to run repeatedly.
 *
 * Each session is purged in its own transaction so one failure cannot block the
 * rest of the sweep — a stuck row must not stop the whole tenant's retention.
 */
async function purgeExpiredSessions(now: Date): Promise<PurgeResult> {
  const due = await findSessionsDueForPurge({ now });
  const totals: Record<string, number> = {};
  let sessionsPurged = 0;
  const failures: string[] = [];
  const touchedCandidates = new Set<string>();

  for (const s of due) {
    const deleted: Record<string, number> = {};
    const count = makeCounter(deleted);
    try {
      await prisma.$transaction(async (tx) => {
        await deleteSessionCascade(tx, [s.sessionId], count);
      }, ERASURE_TX);
    } catch (err) {
      logger.error({ err: String(err), sessionId: s.sessionId }, 'Failed to purge expired session');
      failures.push(s.sessionId);
      continue;
    }
    sessionsPurged += 1;
    touchedCandidates.add(s.candidateId);
    for (const [k, v] of Object.entries(deleted)) totals[k] = (totals[k] ?? 0) + v;

    // Written after the transaction commits so the audit record can never claim
    // a deletion that rolled back. Contains counts and dates only — no name, no
    // email, no transcript text.
    await logAudit({
      tenantId: s.tenantId,
      actorType: 'system',
      actorId: 'retention-sweep',
      action: 'session.purged',
      entityType: 'InterviewSession',
      entityId: s.sessionId,
      after: {
        reason: 'retention window elapsed',
        retainUntil: s.retainUntil.toISOString(),
        usingDefaultWindow: s.usingDefaultWindow,
        retentionDays: retentionDays(),
        deleted,
      },
    });
  }

  // A candidate whose last session just expired has no remaining recruitment
  // purpose, so their Candidate row and résumé profiles go too — otherwise name,
  // email and rawText outlive the interview they were collected for, which is
  // the exact storage-limitation failure this sweep exists to fix. Candidates
  // with any surviving session (including one under legal hold) are left alone.
  let candidatesPurged = 0;
  for (const candidateId of touchedCandidates) {
    const remaining = await prisma.interviewSession.count({ where: { candidateId } });
    if (remaining > 0) continue;

    // The AI interview is only one stage. A candidate still moving through the
    // pipeline, or with a human round or decision inside the window, still has a
    // recruitment purpose; their data goes once all of it has aged out.
    const cutoff = new Date(now.getTime() - retentionDays() * DAY_MS);
    const stillInPipeline = await prisma.candidatePipeline.count({
      where: {
        candidateId,
        OR: [
          { status: 'ACTIVE' },
          { decidedAt: { gt: cutoff } },
          { rounds: { some: { OR: [
            { status: 'SCHEDULED' },
            { completedAt: { gt: cutoff } },
            { completedAt: null, scheduledAt: { gt: cutoff } },
          ] } } },
        ],
      },
    });
    if (stillInPipeline > 0) {
      logger.info({ candidateId }, 'Skipped candidate purge: pipeline still in progress or inside the retention window');
      continue;
    }

    // Candidate-level artifacts (the uploaded résumé) can carry their own hold
    // even with no session left. deleteProfileCascade + the candidate delete
    // below are unconditional, so the hold has to be checked before, not
    // filtered inside — otherwise the sweep would shred held evidence.
    const held = await prisma.artifact.count({ where: { candidateId, legalHold: true } });
    if (held > 0 || await candidateHasHeldObservation(candidateId)) {
      logger.info({ candidateId, held }, 'Skipped candidate purge: artifacts or an observed round under legal hold');
      continue;
    }

    const candidate = await prisma.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, tenantId: true },
    });
    if (!candidate) continue;

    const deleted: Record<string, number> = {};
    const count = makeCounter(deleted);
    try {
      await prisma.$transaction(async (tx) => {
        await deleteProfileCascade(tx, candidateId, count);
        await count('artifacts', () => tx.artifact.deleteMany({ where: { candidateId } }));
        // Same foreign-key ordering as erasure: assignment rows reference the
        // candidate and must go first.
        await deleteCandidateObservations(tx, candidateId, count);
        await count('roundInterviewers', () => tx.roundInterviewer.deleteMany({ where: { round: { pipeline: { candidateId } } } }));
        await deleteRoundCalendarDeliveries(tx, candidateId, count);
        await count('pipelineRounds', () => tx.interviewRound.deleteMany({ where: { pipeline: { candidateId } } }));
        await count('pipelines', () => tx.candidatePipeline.deleteMany({ where: { candidateId } }));
        await count('assignments', () => tx.candidateAssignment.deleteMany({ where: { candidateId } }));
        await count('atsLinks', () => tx.candidateAtsLink.deleteMany({ where: { candidateId } }));
        await count('feedbackOptIns', () => tx.candidateFeedbackOptIn.deleteMany({ where: { candidateId } }));
        await count('feedbackEmails', () => tx.candidateFeedbackEmail.deleteMany({ where: { candidateId } }));
        await count('humanRequests', () => tx.candidateHumanRequest.deleteMany({ where: { candidateId } }));
        await count('feedbackOptInRequests', () => tx.candidateFeedbackOptInRequest.deleteMany({ where: { candidateId } }));
        await count('candidates', () => tx.candidate.deleteMany({ where: { id: candidateId } }));
      }, ERASURE_TX);
    } catch (err) {
      logger.error({ err: String(err), candidateId }, 'Failed to purge orphaned candidate');
      failures.push(candidateId);
      continue;
    }
    candidatesPurged += 1;
    for (const [k, v] of Object.entries(deleted)) totals[k] = (totals[k] ?? 0) + v;

    await logAudit({
      tenantId: candidate.tenantId,
      actorType: 'system',
      actorId: 'retention-sweep',
      action: 'candidate.purged',
      entityType: 'Candidate',
      entityId: candidateId,
      after: { reason: 'no sessions remain within retention', deleted },
    });
  }

  const artifactsPurged = await purgeExpiredArtifacts(now);
  totals['artifacts'] = (totals['artifacts'] ?? 0) + artifactsPurged;

  return {
    sessionsPurged, candidatesPurged, artifactsPurged,
    failed: failures.length, failures, deleted: totals,
  };
}

/**
 * Delete artifacts whose own `retentionDays` window has passed, independently of
 * their session. Returns the number removed. Safe to run repeatedly.
 *
 * SCOPE — this step handles `Artifact` rows only, and deliberately so: an
 * artifact can carry a shorter window than the interview it belongs to (a
 * recording deleted early while the transcript is kept). It is one step of
 * `runRetentionSweep`, not the whole of retention. Session-level data — the
 * canonical transcript in `Turn.text`, `AssessmentVersion.resultJson`,
 * `HumanReview.comments`, `CandidateProfileVersion.rawText` and the `Candidate`
 * row — is deleted by `purgeExpiredSessions`, which runs first in the same
 * sweep.
 *
 * Legal hold, stated precisely: no path in the automatic sweep deletes anything
 * flagged `legalHold`, on either an `Artifact` or an `InterviewSession`, and a
 * hold on a single artifact spares the whole session it belongs to.
 * `eraseCandidate` is a different path — an operator-driven subject request
 * rather than the automatic sweep — but it does NOT override a hold. It
 * refuses outright with a 409 (see its doc comment, and the check it makes
 * before deleting anything). This once said the opposite, which would have
 * told a reader that the strongest protection in the file could be walked
 * past by asking nicely.
 */
export async function purgeExpiredArtifacts(now = new Date()): Promise<number> {
  // retentionDays is per-artifact; SQLite cannot express "createdAt + n days"
  // in a filter, so page through candidates for expiry and check in code.
  const cutoffCandidates = await prisma.artifact.findMany({
    where: {
      retentionDays: { gt: 0 },
      // A hold on the artifact, or on the session it belongs to, wins over the
      // window. The session check has to be explicit: holding a session but
      // silently shredding its recording would defeat the hold.
      legalHold: false,
      OR: [{ sessionId: null }, { session: { legalHold: false } }],
    },
    select: { id: true, createdAt: true, retentionDays: true },
  });
  const expired = cutoffCandidates
    .filter((a) => a.createdAt.getTime() + a.retentionDays * DAY_MS <= now.getTime())
    .map((a) => a.id);
  if (!expired.length) return 0;

  const { count } = await prisma.artifact.deleteMany({ where: { id: { in: expired } } });
  logger.info({ count }, 'Purged artifacts past their retention window');
  return count;
}

/**
 * Clear the record of completed human interview rounds past the retention window.
 *
 * Round notes are candidate personal data written by interviewers, and so is the
 * structured record beside them — more so, because it quotes the candidate. A
 * human round has no interview session, so session-level retention never reaches
 * it, and a candidate with other lawfully kept data is never purged as a whole —
 * without this step both would outlive every window. The round row itself stays,
 * holding no free text, so the pipeline still shows that the round happened.
 */
export async function purgeExpiredRoundNotes(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays() * DAY_MS);
  const expired = await prisma.interviewRound.findMany({
    where: {
      // Two independent conditions, so they are AND-ed explicitly: a second
      // bare `OR:` key would silently replace the first, and the sweep would
      // quietly stop checking the window it exists to enforce.
      AND: [
        // Either half of the record is enough to collect the round: a round
        // whose prose was cleared by an earlier sweep, before the structured
        // record existed, must still have its quotes cleared now.
        { OR: [{ notes: { not: '' } }, { evidenceJson: { notIn: ['[]', ''] } }] },
        // Counted from completion, when the record was written. A round with a
        // record but no completion time (never marked complete) falls back to
        // its scheduled date rather than keeping it for ever.
        { OR: [{ completedAt: { lte: cutoff } }, { completedAt: null, scheduledAt: { lte: cutoff } }] },
      ],
      // A legal hold on any of the candidate's sessions or artifacts spares
      // their round notes too, matching the rest of the sweep.
      pipeline: { candidate: { interviews: { none: { legalHold: true } }, artifacts: { none: { legalHold: true } } } },
    },
    select: { id: true, pipelineId: true, tenantId: true },
  });
  if (expired.length === 0) return 0;

  const ids = expired.map((r) => r.id);
  const heldCandidate = { interviews: { some: { legalHold: true } } };
  const { count } = await prisma.interviewRound.updateMany({
    // Both conditions are checked again at the moment of clearing, against the
    // same cutoff the selection used.
    //
    // The hold, because one placed after the rounds were selected must still
    // spare their record. And the window, because a round selected while it had
    // no completion time can be completed in between — the interviewer writing
    // it up minutes after the sweep read the row — and clearing it then would
    // delete a record written today under a rule about records written months
    // ago. Rechecking costs nothing; the round simply survives to the next sweep.
    where: {
      id: { in: ids },
      OR: [{ notes: { not: '' } }, { evidenceJson: { notIn: ['[]', ''] } }],
      AND: [{ OR: [{ completedAt: { lte: cutoff } }, { completedAt: null, scheduledAt: { lte: cutoff } }] }],
      pipeline: { candidate: { NOT: [heldCandidate, { artifacts: { some: { legalHold: true } } }] } },
    },
    data: { notes: '', evidenceJson: '[]' },
  });
  if (count === 0) return 0;

  // Audit only what was actually cleared, not what was selected.
  const cleared = await prisma.interviewRound.findMany({
    where: { id: { in: ids }, notes: '', evidenceJson: '[]' },
    select: { pipelineId: true, tenantId: true },
  });

  const roundsByPipeline = cleared.reduce<Record<string, { tenantId: string; rounds: number }>>(
    (acc, r) => ({ ...acc, [r.pipelineId]: { tenantId: r.tenantId, rounds: (acc[r.pipelineId]?.rounds ?? 0) + 1 } }),
    {},
  );
  // Counts only — the notes themselves must not survive into the audit log.
  for (const [pipelineId, { tenantId, rounds }] of Object.entries(roundsByPipeline)) {
    await logAudit({
      tenantId, actorType: 'system', actorId: 'retention-sweep',
      action: 'pipeline.round_notes_purged', entityType: 'CandidatePipeline', entityId: pipelineId,
      after: { reason: 'retention window elapsed', rounds, retentionDays: retentionDays(), cleared: ['notes', 'evidence'] },
    });
  }
  logger.info({ count }, 'Cleared interview round notes past their retention window');
  return count;
}

/**
 * One full retention pass: expired sessions and their candidate data first, then
 * the notes of human interview rounds past the window, then signup requests
 * that have already been decided or have expired.
 */
/**
 * Signup requests past their window.
 *
 * A pending request holds a person's name, address and a password hash for an
 * account that does not exist yet, so it is personal data belonging to someone
 * who is not a candidate and has no other record in the system. Once a request
 * has been decided or has expired, nothing needs the row: an approved one has
 * already become a User, and a declined or expired one is a decision nobody can
 * act on again.
 *
 * A request that is still PENDING and still inside its window is never swept,
 * however old. Deleting one would make an operator's queue quietly lose entries
 * they had not answered yet.
 *
 * A PENDING row whose window closed long ago is different: nobody can approve
 * or decline it any more, and if nobody ever opened its link nothing will ever
 * move it out of PENDING. Left alone it would keep a stranger's name, address
 * and password hash indefinitely, which is the one outcome this sweep exists
 * to prevent. It ages from the moment its link expired.
 */
export async function purgeExpiredSignupRequests(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays() * DAY_MS);
  const { count } = await prisma.signupRequest.deleteMany({
    where: {
      OR: [
        {
          status: { in: ['APPROVED', 'DECLINED', 'EXPIRED'] },
          // Decided rows age from the decision; a row that expired without
          // anyone touching it has no decidedAt, so it ages from creation.
          OR: [
            { decidedAt: { lte: cutoff } },
            { decidedAt: null, createdAt: { lte: cutoff } },
          ],
        },
        { status: 'PENDING', expiresAt: { lte: cutoff } },
      ],
    },
  });
  return count;
}

export async function runRetentionSweep(now = new Date()): Promise<PurgeResult> {
  const sessions = await purgeExpiredSessions(now);
  const roundNotes = await purgeExpiredRoundNotes(now);
  const observations = await purgeExpiredObservations(now, retentionDays());
  const roundMeetingLinks = await clearExpiredMeetingLinks(new Date(now.getTime() - retentionDays() * DAY_MS));
  const signupRequests = await purgeExpiredSignupRequests(now);
  const result: PurgeResult = { ...sessions, deleted: { ...sessions.deleted, roundNotes, observations, roundMeetingLinks, signupRequests } };
  // Logged unconditionally and on every outcome. Logging only when something was
  // deleted makes a sweep that has failed on 100% of rows for months look
  // identical to a sweep with nothing to do — and under GDPR Art. 5(2) you must
  // be able to show retention actually ran, not assume it did.
  if (result.failed > 0) {
    logger.error(result, 'Retention sweep completed with failures — data survived its window');
  } else {
    logger.info(result, 'Retention sweep completed');
  }
  return result;
}

/**
 * The job note for one sweep. Throws when any row survived, so the run is
 * recorded as failed and the operator is alerted: a sweep that could not purge
 * must not read "Last succeeded" while the data stays past its window.
 */
export function retentionSweepRunNote(result: PurgeResult): string {
  const deleted = JSON.stringify(result.deleted ?? {});
  if (result.failed === 0) return deleted;
  const ids = result.failures.slice(0, 10).join(', ');
  throw new Error(`${result.failed} rows could not be purged (${ids}${result.failures.length > 10 ? ', ...' : ''}); deleted ${deleted}`);
}

/** Exported so the system health view judges the job by the same interval. */
export const RETENTION_SWEEP_EVERY_MS = 24 * 60 * 60_000;

/** Start the daily retention sweep. Returns a stop function. */
export function startRetentionSweep(intervalMs = RETENTION_SWEEP_EVERY_MS): () => void {
  // Opt-in, and deliberately so. Every existing session has a null `retainUntil`
  // and therefore inherits the default window the moment this ships, so the
  // first sweep on an established database can delete a large backlog of real
  // candidate data. Irreversible deletion must be a decision someone made, not
  // a side effect of deploying. Preview with GET /api/admin/retention/preview,
  // then set RETENTION_SWEEP_ENABLED=true.
  if (process.env.RETENTION_SWEEP_ENABLED !== 'true') {
    logger.warn(
      'Retention sweep is DISABLED (RETENTION_SWEEP_ENABLED is not "true"). Candidate data will be kept past its retention window, ' +
      'which does not satisfy storage limitation. Preview what would be deleted at GET /api/admin/retention/preview, then enable it.',
    );
    return () => {};
  }
  // Under a database lease: two instances must not sweep the same rows, and a
  // failed sweep must be recorded and alerted, not just logged.
  return startJob({
    name: 'retention-sweep',
    intervalMs,
    ttlMs: 60 * 60_000,
    fn: async () => retentionSweepRunNote(await runRetentionSweep()),
  });
}
