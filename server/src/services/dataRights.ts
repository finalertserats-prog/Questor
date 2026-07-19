import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';

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
// The audit trail deliberately survives both erasure and purge. It records THAT
// data was deleted, when, and how much, but holds no personal data itself — you
// cannot demonstrate compliance with a deletion obligation whose record you also
// deleted.

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

/** Effective default window, env-overridable. Invalid values fall back. */
export function retentionDays(): number {
  const raw = Number.parseInt(process.env.RETENTION_DEFAULT_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

const DAY_MS = 86_400_000;

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
async function deleteSessionCascade(
  tx: Prisma.TransactionClient,
  sessionIds: string[],
  count: Counter,
): Promise<void> {
  if (!sessionIds.length) return;

  const assessments = await tx.assessmentVersion.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { id: true },
  });
  const assessmentIds = assessments.map((a) => a.id);

  if (assessmentIds.length) {
    await count('humanReviews', () => tx.humanReview.deleteMany({ where: { assessmentId: { in: assessmentIds } } }));
    await count('assessments', () => tx.assessmentVersion.deleteMany({ where: { id: { in: assessmentIds } } }));
  }
  // Turn.text is the canonical transcript — the single most sensitive record
  // here. If this line does not run, nothing else in the sweep matters.
  await count('turns', () => tx.turn.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('invitations', () => tx.invitation.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('plans', () => tx.interviewPlanVersion.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  // Model executions record prompts/outputs that can quote the candidate.
  await count('modelExecutions', () => tx.modelExecution.deleteMany({ where: { sessionId: { in: sessionIds } } }));
  await count('artifacts', () => tx.artifact.deleteMany({ where: { sessionId: { in: sessionIds } } }));
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
    select: { id: true },
  });
  if (!candidate) throw new Error('Candidate not found in this tenant');

  // A legal hold outranks an erasure request. GDPR Art. 17(3)(e) disapplies the
  // right to erasure where the data is needed to establish, exercise or defend
  // legal claims — which is exactly what a hold marks. Honouring the request
  // anyway would destroy the evidence the hold exists to preserve, through a
  // supported endpoint, at the request of the person the claim may concern.
  // Release the hold deliberately first if erasure is genuinely correct.
  const held = await prisma.interviewSession.count({
    where: {
      candidateId: o.candidateId,
      tenantId: o.tenantId,
      OR: [{ legalHold: true }, { artifacts: { some: { legalHold: true } } }],
    },
  });
  if (held > 0) {
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

  await prisma.$transaction(async (tx) => {
    await deleteSessionCascade(tx, sessionIds, count);
    await deleteProfileCascade(tx, o.candidateId, count);
    // Artifacts attached to the candidate rather than to a session (résumé
    // uploads) are not reached by the session cascade.
    await count('artifacts', () => tx.artifact.deleteMany({ where: { candidateId: o.candidateId } }));
    await count('candidates', () => tx.candidate.deleteMany({ where: { id: o.candidateId, tenantId: o.tenantId } }));
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
      });
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

    // Candidate-level artifacts (the uploaded résumé) can carry their own hold
    // even with no session left. deleteProfileCascade + the candidate delete
    // below are unconditional, so the hold has to be checked before, not
    // filtered inside — otherwise the sweep would shred held evidence.
    const held = await prisma.artifact.count({ where: { candidateId, legalHold: true } });
    if (held > 0) {
      logger.info({ candidateId, held }, 'Skipped candidate purge: artifacts under legal hold');
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
        await count('candidates', () => tx.candidate.deleteMany({ where: { id: candidateId } }));
      });
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
 * `eraseCandidate` is NOT part of that guarantee — it is an operator-driven
 * subject request and overrides holds by design (see its doc comment).
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
 * One full retention pass: expired sessions and their candidate data first, then
 * any artifact that outlived its own shorter window.
 */
export async function runRetentionSweep(now = new Date()): Promise<PurgeResult> {
  const result = await purgeExpiredSessions(now);
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

/** Start the daily retention sweep. Returns a stop function. */
export function startRetentionSweep(intervalMs = 24 * 60 * 60_000): () => void {
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
  const tick = () => {
    runRetentionSweep().catch((e) => logger.error({ err: String(e) }, 'Retention sweep failed'));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
