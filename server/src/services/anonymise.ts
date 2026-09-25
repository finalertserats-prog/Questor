import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { startJob } from './jobs.js';
import { anonymiseCandidateData, claimCandidateForAnonymisation, lockCandidateRecord, type AnonymiseCounter } from './anonymiseCascade.js';

/**
 * Anonymisation: keep the interview, sever the person.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE RETENTION SWEEP. Questor's interviews
 * are the asset — quality analysis, calibration and every judgement about
 * whether the model is behaving depend on having real interviews to read.
 * Deleting them on a timer, which is what dataRights.ts does, buys storage
 * limitation by destroying the thing the product learns from.
 *
 * Archiving them instead solves nothing: data you can retrieve, that identifies
 * a person, is retained personal data whatever table it sits in. What does
 * solve it is removing the person. Data that genuinely cannot be traced back to
 * an individual falls outside GDPR's scope (Recital 26), and can then be kept
 * indefinitely and used for exactly what it is wanted for.
 *
 * THE PROPERTY EVERYTHING ELSE FOLLOWS FROM: this must be IRREVERSIBLE. If the
 * original identity can be recovered — from a kept column, a reversible hash, a
 * mapping row, a foreign key that still points at a named record, an identifier
 * the candidate is holding — then it is pseudonymisation, the data is still
 * personal data, and the only thing achieved is confidence that it is not. See
 * anonymiseCascade.ts, where every delete is justified by that sentence.
 *
 * WHAT THIS HONESTLY DELIVERS. Questor knows the candidate's name, address,
 * phone and LinkedIn URL exactly, so it removes those wherever they appear,
 * including in the transcript. It cannot find the third parties a candidate
 * mentions in passing — a former employer, a manager, the team they were on —
 * and nothing here pretends it can. See `retentionPostureMessage` below, which
 * is worded to claim what is true and no more.
 *
 * THIS IS NOT ERASURE. A candidate exercising their right to erasure is still
 * erased outright by `eraseCandidate`; that is a legal obligation owed to a
 * person who asked, and no retention policy replaces it.
 */

const DAY_MS = 86_400_000;

/**
 * Above Prisma's five-second default. One candidate's cascade is a long chain
 * of statements — every turn of a long interview is read, redacted and written
 * back — and a timeout part-way is a rollback, not a half-done job, so the
 * cost of setting this too low is a candidate that never gets anonymised
 * rather than one that half does.
 */
const ANONYMISE_TIMEOUT_MS = 60_000;

/** Run `body`, retrying once if the database refused to serialise it. */
async function withRetry<T>(body: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await body();
    } catch (err) {
      if (!isSerializationFailure(err) || attempt >= ANONYMISE_ATTEMPTS) throw err;
    }
  }
}

/**
 * How long a candidate's identity stays attached to their interview.
 *
 * Twelve months, decided by the owner. It is long enough that a real hiring
 * decision still works end to end — an offer, a decline, a backfill, a
 * candidate coming back for a second role and being recognised — and short
 * enough that "we still know who gave that interview" does not quietly become
 * a permanent state of affairs.
 */
export const DEFAULT_ANONYMISE_AFTER_DAYS = 365;

/**
 * Effective window, env-overridable, with the same round-trip check as
 * `retentionDays` in dataRights.ts and for the same scar: parseInt reads "2w"
 * as 2, and a typo in a deploy variable that shortens this window strips the
 * identity off interviews nowhere near the end of their life. Unlike a purge,
 * which is at least obviously catastrophic, a premature anonymisation looks
 * like nothing happened until someone goes looking for a candidate.
 */
export function anonymiseAfterDays(): number {
  const configured = process.env.ANONYMISE_AFTER_DAYS;
  if (configured === undefined) return DEFAULT_ANONYMISE_AFTER_DAYS;
  const trimmed = configured.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    logger.warn(
      { value: configured, usingDays: DEFAULT_ANONYMISE_AFTER_DAYS },
      'ANONYMISE_AFTER_DAYS is not a positive whole number of days; ignoring it and using the default',
    );
    return DEFAULT_ANONYMISE_AFTER_DAYS;
  }
  return parsed;
}

/** Whether this deployment has opted in to anonymising anything. */
export function anonymisationEnabled(): boolean {
  return process.env.ANONYMISE_SWEEP_ENABLED === 'true';
}

interface CandidateInterview {
  readonly id: string;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * When this application's clock last restarted.
 *
 * The anchor is the most recent interview on THIS candidate row, measured from
 * completion — the moment the conversation actually happened — falling back to
 * creation for an interview that was never completed, so an abandoned one
 * cannot keep a person named for ever by never being closed.
 *
 * A row with no interview at all (an application that never got that far) ages
 * from when it was created. There is no interview to date it from, and the name
 * and address on it are personal data all the same.
 *
 * RETURNING CANDIDATES. Questor writes one Candidate row per application, so a
 * person who comes back for a second role gets a second row with its own clock.
 * Their older application is anonymised on schedule while the newer one stays
 * named — which is the right answer: the recruitment purpose that justifies
 * knowing who gave the old interview really has expired, and the new one is
 * live. The two rows stop being linkable at that point, so reuse of an
 * anonymised application is gone by design rather than by accident.
 */
function anonymiseAnchor(row: { readonly createdAt: Date; readonly interviews: readonly CandidateInterview[] }): Date {
  const interviews = row.interviews.map((s) => s.completedAt ?? s.createdAt);
  return interviews.length === 0
    ? row.createdAt
    : new Date(Math.max(...interviews.map((d) => d.getTime())));
}

/**
 * Everything that disqualifies a candidate from being anonymised, expressed as
 * ONE predicate so the selection and the re-check inside the transaction cannot
 * drift apart — the shape purgeExpiredObservations uses in observerRetention.ts.
 *
 * LEGAL HOLD BLOCKS ANONYMISATION, exactly as it blocks erasure, and for a
 * sharper reason. A hold marks data needed to establish or defend a legal claim
 * (GDPR Art. 17(3)(e)); stripping the identity out of it destroys the thing
 * that makes it evidence, while leaving a transcript behind that looks intact.
 * That is a worse failure than deleting it, because it is silent.
 *
 * The hold is read at every level it can be set, matching the retention sweep:
 * on the interview, on any single file belonging to it, and on files that hang
 * off the candidate rather than a session. A hold on an observed human round is
 * checked separately — RoundObservation has no relation back to Candidate, so
 * it cannot be expressed here and is counted in code instead.
 */
function anonymisableWhere(now: Date, tenantId?: string): Prisma.CandidateWhereInput {
  const cutoff = new Date(now.getTime() - anonymiseAfterDays() * DAY_MS);
  return {
    anonymisedAt: null,
    ...(tenantId ? { tenantId } : {}),
    interviews: { none: { OR: [{ legalHold: true }, { artifacts: { some: { legalHold: true } } }] } },
    artifacts: { none: { legalHold: true } },
    // A candidate still moving through a pipeline, or decided recently, or with
    // a round scheduled or lately completed, has a live recruitment purpose.
    // Knowing who they are is still the point; the window has not started.
    pipelines: {
      none: {
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
    },
  };
}

export interface DueAnonymisation {
  readonly candidateId: string;
  readonly tenantId: string;
  /** Shown in the preview so an operator can see WHO before anything is done. */
  readonly candidateName: string;
  readonly sessionIds: readonly string[];
  readonly lastInterviewAt: Date | null;
  readonly anonymiseAfter: Date;
  readonly counts: { readonly sessions: number; readonly turns: number };
}

/**
 * Candidates whose window has closed. Read-only.
 *
 * The preview an operator sees is built from THIS function, and so is the sweep
 * that does the work, so the two cannot disagree — the same reasoning as
 * `findSessionsDueForPurge`, and the reason that comment insists on it. A
 * preview assembled from its own query is a preview of a different thing, and
 * the difference only ever shows up after the irreversible part has run.
 */
export async function findCandidatesDueForAnonymisation(o: {
  readonly now?: Date;
  readonly tenantId?: string;
} = {}): Promise<DueAnonymisation[]> {
  const now = o.now ?? new Date();
  const days = anonymiseAfterDays();
  const rows = await prisma.candidate.findMany({
    where: anonymisableWhere(now, o.tenantId),
    select: {
      id: true, tenantId: true, fullName: true, createdAt: true,
      interviews: { select: { id: true, completedAt: true, createdAt: true } },
    },
  });

  // Neither SQLite nor a portable Prisma filter can express "anchor + n days",
  // so expiry is decided in code — as it is for retention. Everything that
  // must not be lost to a bug in this filtering (the holds) is already pushed
  // into the query above.
  const due = rows.filter((row) => anonymiseAnchor(row).getTime() + days * DAY_MS <= now.getTime());
  if (!due.length) return [];

  // A hold on an AI-observed human round spares the candidate too. It cannot be
  // joined from Candidate, so it is a second pass rather than a filter.
  const heldCandidates = new Set(
    (await prisma.roundObservation.findMany({
      where: { legalHold: true, candidateId: { in: due.map((d) => d.id) } },
      select: { candidateId: true },
    })).map((r) => r.candidateId),
  );

  const eligible = due.filter((row) => !heldCandidates.has(row.id));
  if (!eligible.length) return [];

  const turns = await prisma.turn.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: eligible.flatMap((row) => row.interviews.map((s) => s.id)) } },
    _count: { _all: true },
  });
  const turnsBySession = new Map(turns.map((t) => [t.sessionId, t._count._all]));
  const turnsIn = (sessionIds: readonly string[]): number =>
    sessionIds.reduce((sum, id) => sum + (turnsBySession.get(id) ?? 0), 0);

  return eligible.map((row) => {
    const sessionIds = row.interviews.map((s) => s.id);
    const anchor = anonymiseAnchor(row);
    return {
      candidateId: row.id,
      tenantId: row.tenantId,
      candidateName: row.fullName,
      sessionIds,
      lastInterviewAt: row.interviews.length ? anchor : null,
      anonymiseAfter: new Date(anchor.getTime() + days * DAY_MS),
      counts: { sessions: sessionIds.length, turns: turnsIn(sessionIds) },
    };
  });
}

export interface AnonymiseResult {
  readonly candidatesAnonymised: number;
  /** Selected but skipped at the last moment — a hold arrived, or a new interview did. */
  readonly skipped: number;
  /** Candidates the sweep tried and failed to anonymise. Non-zero means identity survived. */
  readonly failed: number;
  readonly failures: readonly string[];
  readonly changed: Record<string, number>;
}

/**
 * One candidate's transaction lost a serialisation conflict. Same shape as the
 * check in candidateReuse.ts, kept local rather than exported from there so
 * this file does not reach across lanes for two lines.
 */
const isSerializationFailure = (err: unknown): boolean => {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  // P2034 is Prisma's own write-conflict code. A serialization failure raised
  // by a RAW statement — which `lockCandidateRecord` is — surfaces as P2010
  // carrying Postgres's 40001 instead, and the one race the lock exists for is
  // exactly when that happens. Without this the outcome is still safe (the
  // hold wins) but the run is recorded as failed and the operator is alerted
  // for what this file describes as an ordinary skip.
  return err.code === 'P2034' || (err.code === 'P2010' && /40001|could not serialize/i.test(err.message));
};

/**
 * One retry. A conflict here means somebody wrote to this candidate's
 * interviews or files while the sweep was reading them — very often the
 * administrator placing the hold. On the retry the claim below sees the hold
 * and the candidate is skipped, which is the outcome we want.
 */
const ANONYMISE_ATTEMPTS = 2;

/** Why one candidate was not anonymised on this pass. */
type Outcome = 'anonymised' | 'skipped';

/**
 * Anonymise every candidate past the window.
 *
 * Each candidate is done in its own transaction, so one stuck row cannot block
 * the rest of the sweep, and so no candidate can ever be left half-severed:
 * within a transaction it is all or none.
 *
 * HOW THE LEGAL HOLD IS ACTUALLY PROTECTED, corrected. This comment used to
 * say Serializable closed the race, and that was wrong: Postgres's SSI only
 * detects conflicts among transactions that are THEMSELVES serializable, and
 * the administrator placing a hold (routes/admin.ts) runs an ordinary
 * read-committed update. It would never have been a party to the conflict, so
 * nothing would have aborted — and the sweep writes the session row only when
 * `consentJson` actually changes, so there is often no write-write conflict to
 * detect either. The window was the whole transaction, not the instant the
 * comment described.
 *
 * What closes it is a ROW LOCK, taken on the rows the hold decision reads
 * before that decision is made. An administrator's update to
 * `InterviewSession.legalHold` then waits behind this transaction instead of
 * slipping between the check and the deletes. The guarantee that holds is
 * precise: a hold committed before the lock is taken always wins, and one
 * committed after it waits and applies to a candidate that is already
 * anonymised. Serializable stays, because it is still what makes the sweep's
 * own reads consistent, but it is not what makes the hold safe.
 */
export async function runAnonymisationSweep(now = new Date()): Promise<AnonymiseResult> {
  const due = await findCandidatesDueForAnonymisation({ now });
  const days = anonymiseAfterDays();
  const totals: Record<string, number> = {};
  const failures: string[] = [];
  let anonymised = 0;
  let skipped = 0;

  for (const candidate of due) {
    // Reset per attempt: a retried transaction runs the whole body again, and
    // counts accumulated by the attempt that rolled back describe work that
    // never happened.
    let changed: Record<string, number> = {};

    let outcome: Outcome;
    try {
      outcome = await withRetry(() => prisma.$transaction(async (tx): Promise<Outcome> => {
        changed = {};
        const count: AnonymiseCounter = (label, value) => { changed[label] = (changed[label] ?? 0) + value; };

        // Re-read the window from what the row says NOW. A candidate can start
        // a new interview between the selection and here, which restarts their
        // clock, and severing them at that moment would anonymise an interview
        // happening today under a rule about interviews from a year ago. This
        // one cannot ride on the write below — no portable Prisma filter can
        // express "anchor + n days" — so it rests on the lock taken above,
        // which holds the candidate and their sessions for the transaction.
        // Before anything is read that a hold could change. lockCandidateRecord
        // is a no-op on SQLite, which serialises writers anyway.
        await lockCandidateRecord(tx, candidate.candidateId);

        const row = await tx.candidate.findUnique({
          where: { id: candidate.candidateId },
          select: { id: true, createdAt: true, interviews: { select: { id: true, completedAt: true, createdAt: true } } },
        });
        if (!row) return 'skipped';
        if (anonymiseAnchor(row).getTime() + days * DAY_MS > now.getTime()) return 'skipped';

        // A hold on an AI-observed human round. RoundObservation has no
        // relation back to Candidate, so this cannot be part of the claim's
        // predicate either. The sweep writes these rows itself, so a hold
        // arriving concurrently does conflict on them — this is the one place
        // Serializable genuinely carries the weight.
        if (await tx.roundObservation.count({ where: { candidateId: row.id, legalHold: true } }) > 0) return 'skipped';

        // THE GUARD. Everything that can disqualify this candidate and CAN be
        // expressed as a filter rides on this statement, so the database — not
        // the order of the lines below — decides whether the destructive work
        // may happen. A hold placed since the selection makes the predicate
        // stop matching, the update changes nothing, and we leave without
        // having touched a row.
        const claim = await claimCandidateForAnonymisation(tx, {
          candidateId: candidate.candidateId,
          now,
          eligible: anonymisableWhere(now),
        });
        if (!claim) return 'skipped';

        // Taking a claim is the only way to reach this: `anonymiseCandidateData`
        // requires one, and only the conditional write above mints one.
        await anonymiseCandidateData(tx, claim, count);

        // The record of what just happened, written in the SAME transaction.
        //
        // It used to be written after the commit, on the reasoning that an
        // audit row must never claim a change that rolled back. True, but it
        // bought that by taking the opposite risk: if the write failed, the
        // candidate was anonymised, `anonymisedAt` was set, and nothing
        // anywhere recorded it — and no later run would notice, because the
        // candidate is no longer eligible. Inside the transaction both
        // directions hold: no record without the change, no change without the
        // record. Written through `tx` rather than `logAudit`, which uses the
        // global client and swallows its own failures.
        //
        // Counts and dates only. The audit trail outlives the data it
        // describes, and a row naming the person we just removed would BE the
        // mapping table this design exists to avoid — which is also why the
        // sweep clears the payloads of the candidate's OWN history (see
        // anonymiseCascade.ts `clearAuditPayloads`).
        await tx.auditEvent.create({
          data: {
            tenantId: claim.tenantId,
            actorType: 'system',
            actorId: 'anonymisation-sweep',
            action: 'candidate.anonymised',
            entityType: 'Candidate',
            entityId: claim.candidateId,
            afterJson: JSON.stringify({
              reason: 'anonymisation window elapsed',
              anonymiseAfterDays: days,
              lastInterviewAt: candidate.lastInterviewAt?.toISOString() ?? null,
              changed,
            }),
          },
        });
        return 'anonymised';
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: ANONYMISE_TIMEOUT_MS }));
    } catch (err) {
      logger.error({ err: String(err), candidateId: candidate.candidateId }, 'Failed to anonymise candidate');
      failures.push(candidate.candidateId);
      continue;
    }
    if (outcome === 'skipped') { skipped += 1; continue; }
    anonymised += 1;
    for (const [k, v] of Object.entries(changed)) totals[k] = (totals[k] ?? 0) + v;
  }

  const result: AnonymiseResult = { candidatesAnonymised: anonymised, skipped, failed: failures.length, failures, changed: totals };
  // Logged on every outcome, including nothing-to-do. A sweep failing on every
  // row for months must not look identical to a sweep with no work.
  if (result.failed > 0) logger.error(result, 'Anonymisation sweep completed with failures — candidate identity survived its window');
  else logger.info(result, 'Anonymisation sweep completed');
  return result;
}

/**
 * The job note for one sweep. Throws when any candidate could not be done, so
 * the run is recorded as failed and the operator is alerted rather than the
 * operations view reading "Last succeeded" over data that is still named.
 */
export function anonymisationSweepRunNote(result: AnonymiseResult): string {
  const changed = JSON.stringify(result.changed ?? {});
  if (result.failed === 0) return changed;
  const ids = result.failures.slice(0, 10).join(', ');
  throw new Error(`${result.failed} candidates could not be anonymised (${ids}${result.failures.length > 10 ? ', ...' : ''}); changed ${changed}`);
}

/** Exported so the system health view judges this job by the same interval. */
export const ANONYMISATION_SWEEP_EVERY_MS = 24 * 60 * 60_000;

/** Start the daily anonymisation sweep. Returns a stop function. */
export function startAnonymisationSweep(intervalMs = ANONYMISATION_SWEEP_EVERY_MS): () => void {
  // Opt-in, exactly as the retention sweep is, and for a reason that is if
  // anything stronger. Every candidate older than the window becomes eligible
  // the moment this ships, so the first run on an established database rewrites
  // a large backlog of real customer data in a way no later fix can undo.
  // Preview with GET /api/admin/anonymisation/preview, then set
  // ANONYMISE_SWEEP_ENABLED=true.
  if (!anonymisationEnabled()) return () => {};
  // Under the same database lease as every other sweep: two instances must not
  // process the same candidates, and a failed run must be recorded and alerted.
  return startJob({
    name: 'anonymisation-sweep',
    intervalMs,
    ttlMs: 60 * 60_000,
    fn: async () => anonymisationSweepRunNote(await runAnonymisationSweep()),
  });
}

/**
 * What this deployment actually does with old interviews, said out loud at boot.
 *
 * The old message assumed there was one right answer and that a deployment not
 * doing it was misconfigured. There are two, and they are different trades: the
 * retention sweep buys storage limitation by deleting the interview, and
 * anonymisation buys it by keeping the interview and removing the person. A
 * server that describes its own configuration is more use than one that repeats
 * a warning nobody can act on.
 *
 * The wording is deliberately narrow. It says the identifying details Questor
 * HOLDS are removed, because that is the claim the code can support. It does
 * not say "anonymised" without qualification, because a transcript can still
 * name a former employer or a manager and no honest process claims otherwise.
 */
export function retentionPostureMessage(o: { readonly sweepEnabled: boolean; readonly anonymiseEnabled: boolean }): {
  readonly level: 'warn' | 'info';
  readonly message: string;
} {
  if (o.anonymiseEnabled && o.sweepEnabled) {
    return {
      level: 'info',
      message:
        `Retention sweep ON and anonymisation ON. Interviews are deleted once their retention window closes, so most will never reach the ` +
        `${anonymiseAfterDays()}-day anonymisation window; any that are held back from deletion have the identifying details Questor holds ` +
        'removed once they do. Check that this combination is what you meant — anonymisation is normally an alternative to deletion, not an addition to it.',
    };
  }
  if (o.anonymiseEnabled) {
    return {
      level: 'info',
      message:
        `Retention sweep OFF, anonymisation ON. Interviews are kept indefinitely; ${anonymiseAfterDays()} days after an interview the ` +
        'identifying details Questor holds about the candidate — name, address, phone, LinkedIn — are irreversibly removed from it, ' +
        'including from the transcript. Third parties a candidate mentions in passing cannot be found this way and may remain, ' +
        'and so can a spelling of their own address that Questor does not hold.',
    };
  }
  if (o.sweepEnabled) {
    return {
      level: 'info',
      message: 'Retention sweep ON, anonymisation OFF. Candidate data is deleted once its retention window closes.',
    };
  }
  return {
    level: 'warn',
    message:
      'Retention sweep and anonymisation are both DISABLED. Candidate interviews are kept indefinitely with the candidate identified, ' +
      'which does not satisfy storage limitation. Either delete on a window (preview at GET /api/admin/retention/preview, then set ' +
      'RETENTION_SWEEP_ENABLED=true) or keep the interviews and remove the person (preview at GET /api/admin/anonymisation/preview, ' +
      'then set ANONYMISE_SWEEP_ENABLED=true).',
  };
}
