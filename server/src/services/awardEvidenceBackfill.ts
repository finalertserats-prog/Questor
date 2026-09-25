import { prisma } from '../db.js';
import { logAuditIn } from './audit.js';
import { logger } from '../logger.js';
import { startJob } from './jobs.js';
import { upgradeLegacyEvidence, type LegacyStoredEvidence } from '../domain/candidateAwards.js';
import { CERTIFICATE_TIERS, parseAwardEvidence, parseStoredEvidence } from './awardEvidence.js';

/**
 * Bringing the awards that were struck before the record held a name up to
 * the shape a certificate can be drawn from.
 *
 * ---- Why this is a sweep and not something the export does
 *
 * Every award in the database is a version-1 record: the five evidence rows,
 * and nothing saying whose record they are. An earlier draft of this lane
 * repaired that on the way past the export — resolve the name, write it back,
 * then render. It passed its tests and it was wrong, for a reason worth
 * keeping written down, because it is not obvious and two review rounds went
 * into hardening the mechanism before anyone questioned the mechanism:
 *
 * A migration inside a read endpoint issues documents it has not stored. Two
 * exports racing both build from live rows; one wins the write and the other
 * still hands its reader the version it built, so two certificates go out
 * under one reference and the stored row matches neither. A write that fails
 * is worse — the export proceeds and issues a document nothing has frozen, so
 * a rename tomorrow produces a different certificate for the same award. Every
 * guard against that is a guard against a hazard the design created.
 *
 * The rule instead: never issue content that was not derived from one
 * committed record. Migrate at rest, refuse at read. This is the migrating
 * half; `certificateEvidence` is the refusing half.
 *
 * ---- What it resolves, and what it refuses to
 *
 * The name and the title are RESOLVED from the rows the award already points
 * at; the signatures are NOT reconstructed. `upgradeLegacyEvidence` in the
 * domain carries that argument. The short of it is that following a frozen
 * pointer is not the same act as re-deriving a claim about what happened.
 *
 * ---- Why Diamond is left alone
 *
 * Deliberately, and not as an oversight. Diamond carries no certificate, so
 * nothing ever renders its record; the journey reads its rows and both
 * versions hold those under the same name. Upgrading it would freeze a
 * candidate's name onto a record that will never print one — which is
 * personal data stored for no purpose, and the argument for freezing a name
 * at all is that a certificate needs it.
 */

/** Read in pages so a large tenant is never loaded at once. */
const PAGE = 200;

/**
 * Two small writes, and still not left on Prisma's five-second default.
 *
 * `dataRights.ts` was bitten by exactly that: work that finishes comfortably
 * on an idle database — the reason it survived every green suite — and does
 * not under load, rolling back with P2028. The failure here is far gentler
 * than an erasure reporting failure to somebody exercising a right: the record
 * stays version 1, it is counted as failed rather than done, and the next run
 * picks it up. But "gentler" still means a certificate refused for another
 * hour because the database was busy for a moment, and there is nothing to be
 * gained by giving up that early.
 *
 * `maxWait` is raised for the same reason one step earlier: under the load
 * that makes the work slow, waiting for a free connection is also slow, and
 * the two-second default would give up before any work began. Modest rather
 * than generous, because unlike an erasure this genuinely is two statements
 * and a long wait here would mean something else is wrong.
 */
const UPGRADE_TX = { timeout: 30_000, maxWait: 15_000 } as const;

/** Hourly, and it stops itself once there is nothing left — see `startAwardEvidenceBackfill`. */
export const AWARD_EVIDENCE_BACKFILL_EVERY_MS = 60 * 60_000;

export interface BackfillResult {
  /** Records this run brought up to date. */
  readonly upgraded: number;
  /** Records another instance had already taken by the time this run wrote. */
  readonly overtaken: number;
  /** Records that could not be brought up to date, and are still version 1. */
  readonly failed: number;
  /** Version-1 records still outstanding when this run finished. */
  readonly remaining: number;
}

interface LegacyAward {
  readonly id: string;
  readonly tenantId: string;
  readonly candidateId: string;
  readonly roleId: string;
  readonly tier: string;
  readonly reference: string;
  readonly evidenceJson: string;
}

export async function backfillLegacyAwardEvidence(): Promise<BackfillResult> {
  let upgraded = 0;
  let overtaken = 0;
  let failed = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.candidateAward.findMany({
      // Only the tiers that carry a certificate, for the reason at the top.
      where: { tier: { in: [...CERTIFICATE_TIERS] } },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, tenantId: true, candidateId: true, roleId: true, tier: true, reference: true, evidenceJson: true },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    const outstanding = page.flatMap((award) => {
      const legacy = legacyRecordOf(award);
      // The parsed record is carried rather than re-derived in `settle`. A
      // second parse there would have to be narrowed or cast back to legacy,
      // and a cast is a claim the compiler stops checking — the kind that is
      // right until the classification above changes.
      return legacy ? [{ award, legacy }] : [];
    });
    if (outstanding.length > 0) {
      const names = await resolveNames(outstanding.map((entry) => entry.award));
      for (const entry of outstanding) {
        const outcome = await settle(entry.award, entry.legacy, names);
        if (outcome === 'upgraded') upgraded += 1;
        else if (outcome === 'overtaken') overtaken += 1;
        else failed += 1;
      }
    }
    if (page.length < PAGE) break;
  }

  return { upgraded, overtaken, failed, remaining: await countLegacy() };
}

/**
 * Classified by the reader that serves the export, so this sweep and that
 * refusal can never disagree about what a record is. A record that is neither
 * version is left where it is: it is corrupt rather than old, and a migration
 * is not the place to decide what to do about that.
 */
function legacyRecordOf(award: LegacyAward): LegacyStoredEvidence | null {
  try {
    const stored = parseStoredEvidence(award.id, award.evidenceJson);
    return stored.kind === 'legacy' ? stored.legacy : null;
  } catch (err) {
    logger.error(
      { awardId: award.id, err: err instanceof Error ? err.message : String(err) },
      'award evidence can be read as neither version; the backfill has left it alone',
    );
    return null;
  }
}

/** One read per page for candidates and one for roles, rather than two per award. */
async function resolveNames(awards: readonly LegacyAward[]) {
  const [candidates, roles] = await Promise.all([
    prisma.candidate.findMany({
      where: { id: { in: [...new Set(awards.map((award) => award.candidateId))] } },
      select: { id: true, tenantId: true, fullName: true },
    }),
    prisma.role.findMany({
      where: { id: { in: [...new Set(awards.map((award) => award.roleId))] } },
      select: { id: true, tenantId: true, title: true },
    }),
  ]);
  // Keyed by tenant as well as id, so a row can only ever supply a name to an
  // award of its own organisation.
  return {
    candidateName: new Map(candidates.map((row) => [`${row.tenantId}:${row.id}`, row.fullName])),
    roleTitle: new Map(roles.map((row) => [`${row.tenantId}:${row.id}`, row.title])),
  };
}

type Outcome = 'upgraded' | 'overtaken' | 'failed';

async function settle(
  award: LegacyAward,
  legacy: LegacyStoredEvidence,
  names: Awaited<ReturnType<typeof resolveNames>>,
): Promise<Outcome> {
  try {
    const upgraded = upgradeLegacyEvidence({
      legacy,
      // An absent row leaves the placeholder the writer uses for the same gap,
      // so the record says what is missing rather than failing to exist.
      candidateName: names.candidateName.get(`${award.tenantId}:${award.candidateId}`) ?? '',
      roleTitle: names.roleTitle.get(`${award.tenantId}:${award.roleId}`) ?? '',
    });
    const evidenceJson = JSON.stringify(upgraded);

    // Validated by the same reader that serves every certificate, before it is
    // stored. This sweep cannot put a record into the database that the
    // renderer would then refuse.
    parseAwardEvidence(award.id, evidenceJson);

    /**
     * The record and the note that it changed, in one transaction.
     *
     * `logAudit` would have been the obvious call and it is the wrong one
     * here: it runs on the shared client and swallows its own failures, so an
     * audit that could not be written would leave a row already upgraded, no
     * event saying so, and — the part that makes it permanent — nothing that
     * would ever retry, because the row no longer reads as legacy and the next
     * run skips it. This sweep says it audits what it changes; both or neither
     * is what makes that true rather than usually true.
     */
    return await prisma.$transaction(async (tx) => {
      // Conditional on the bytes that were read, so two instances sweeping
      // together cannot both apply it and neither can overwrite a record that
      // changed underneath.
      const claimed = await tx.candidateAward.updateMany({
        where: { id: award.id, tenantId: award.tenantId, evidenceJson: award.evidenceJson },
        data: { evidenceJson },
      });
      if (claimed.count === 0) return 'overtaken';

      await logAuditIn(tx, {
        tenantId: award.tenantId,
        // The system, because it is one. Nobody asked for this and nobody
        // approved it; a trail naming a person for a migration would be the
        // wrong sentence about them.
        actorId: 'evidence-backfill',
        actorType: 'system',
        action: 'candidate.award.evidence_upgraded',
        entityType: 'CandidateAward',
        entityId: award.id,
        // The tier and the reference, and never the name that was resolved.
        // The trail outlives the award, so a name written here would be a copy
        // of it in a place an erasure does not reach.
        after: { tier: award.tier, reference: award.reference, from: 1, to: 2 },
      });
      return 'upgraded';
    }, UPGRADE_TX);
  } catch (err) {
    // One award that cannot be migrated must not stop the sweep reaching the
    // rest. It stays version 1, so the export goes on refusing it and the next
    // run tries again — which is the honest state, not a hidden one.
    logger.error(
      { awardId: award.id, err: err instanceof Error ? err.message : String(err) },
      'an award struck before the record held a name could not be brought up to date; its certificate will be refused until it is',
    );
    return 'failed';
  }
}

async function countLegacy(): Promise<number> {
  const awards = await prisma.candidateAward.findMany({
    where: { tier: { in: [...CERTIFICATE_TIERS] } },
    select: { id: true, evidenceJson: true },
  });
  return awards.filter((award) => {
    try {
      return parseStoredEvidence(award.id, award.evidenceJson).kind === 'legacy';
    } catch {
      return false;
    }
  }).length;
}

export function backfillRunNote(result: BackfillResult): string {
  return `brought ${result.upgraded} award records up to date (${result.overtaken} taken by another instance, ${result.failed} failed, ${result.remaining} still outstanding)`;
}

/**
 * A one-shot migration wearing a job's clothes.
 *
 * It runs at startup rather than on a delay, because until it finishes every
 * certificate for an existing award is refused, and it takes itself off the
 * schedule the moment nothing is outstanding. It stays on the schedule while
 * anything has failed, so a transient database fault is retried rather than
 * needing somebody to notice.
 */
export function startAwardEvidenceBackfill(intervalMs = AWARD_EVIDENCE_BACKFILL_EVERY_MS): () => void {
  let unschedule: (() => void) | null = null;
  let done = false;

  unschedule = startJob({
    name: 'award-evidence-backfill',
    intervalMs,
    ttlMs: 10 * 60_000,
    fn: async () => {
      // `unschedule` is assigned before the first tick can reach here, because
      // taking the run's lease is asynchronous. Re-checked anyway so that a
      // finished sweep always ends up off the schedule rather than relying on
      // that ordering.
      if (done) {
        unschedule?.();
        return 'nothing left to bring up to date';
      }
      const result = await backfillLegacyAwardEvidence();
      if (result.remaining === 0) {
        done = true;
        unschedule?.();
      }
      return backfillRunNote(result);
    },
  });

  return () => {
    done = true;
    unschedule?.();
  };
}
