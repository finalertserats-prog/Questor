import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import { candidateUnderLegalHold, eraseCandidate } from './dataRights.js';
import { normalizeEmail } from './userEmail.js';

/**
 * Erasing a person, not one application.
 *
 * A Candidate row is one person's application to one role, so a person who
 * applied to three roles is three rows. An erasure request is about the
 * person: this finds every application in the tenant with the same normalised
 * address and erases each through eraseCandidate — the same cascade, vendor
 * clean-up and per-row audit entry as a single erasure. A row under legal hold
 * is skipped and reported, never erased (see eraseCandidate for why a hold
 * outranks the request).
 */

export interface SkippedApplication {
  readonly candidateId: string;
  readonly reason: 'legal_hold';
}

export interface PersonErasureResult {
  readonly candidateId: string;
  /** Whether the application the request named is gone. */
  readonly erased: boolean;
  readonly erasedIds: readonly string[];
  readonly skipped: readonly SkippedApplication[];
  /**
   * Applications an error stopped. The requested one is then left in place
   * (and not listed here) so the same request can be retried to finish.
   */
  readonly failed: readonly { readonly candidateId: string }[];
  readonly erasedAt: string;
}

/**
 * Ids of every application for this address among the rows `scope` allows.
 *
 * A row written before emailNormalized existed may still hold the default ''.
 * The migration backfilled those, but a row missed here is personal data an
 * erasure promised to remove, so blank rows are also compared in code.
 */
export async function applicationIdsForAddress(scope: Record<string, unknown>, address: { email: string; emailNormalized: string }): Promise<string[]> {
  const key = address.emailNormalized || normalizeEmail(address.email);
  if (!key) return [];
  const rows = await prisma.candidate.findMany({
    where: { AND: [scope, { OR: [{ emailNormalized: key }, { emailNormalized: '' }] }] },
    select: { id: true, email: true, emailNormalized: true },
  });
  return rows.filter((r) => (r.emailNormalized || normalizeEmail(r.email)) === key).map((r) => r.id);
}

/** Every application the caller may see for the address behind `candidateId`, that one included. */
async function applicationsOfPerson(tenantId: string, candidateId: string, scope: Record<string, unknown>): Promise<string[]> {
  const row = await prisma.candidate.findFirst({ where: { id: candidateId, tenantId }, select: { email: true, emailNormalized: true } });
  if (!row) throw new HttpError(404, 'Candidate not found');
  const ids = await applicationIdsForAddress({ AND: [{ tenantId }, scope] }, row);
  return [...new Set([candidateId, ...ids])].sort();
}

const isHoldRefusal = (err: unknown): boolean => err instanceof HttpError && err.status === 409;

type Outcome = 'erased' | 'held' | 'failed';

/**
 * Erase one application, or report it as held or failed. A hold placed after
 * the check still wins. A row that vanished meanwhile (another erasure got
 * there first) counts as erased; any other error is reported, not thrown, so
 * one bad row cannot stop the rest or the audit entry.
 */
async function eraseOrSkip(o: { tenantId: string; candidateId: string; actorId: string; reason: string }): Promise<Outcome> {
  try {
    if (await candidateUnderLegalHold(o.candidateId, o.tenantId)) return 'held';
    await eraseCandidate(o);
    return 'erased';
  } catch (err) {
    if (isHoldRefusal(err)) return 'held';
    const stillThere = await prisma.candidate.count({ where: { id: o.candidateId, tenantId: o.tenantId } }).catch(() => 1);
    if (stillThere === 0) return 'erased';
    logger.error({ candidateId: o.candidateId, err: err instanceof Error ? err.message : String(err) }, 'Could not erase one of a person\'s applications');
    return 'failed';
  }
}

export async function eraseAllApplications(o: {
  tenantId: string;
  candidateId: string;
  actorId: string;
  reason: string;
  // The caller's candidate scope. Only admins can erase today and they see the
  // whole tenant, but a scoped role granted erasure must not reach past it.
  scope?: Record<string, unknown>;
}): Promise<PersonErasureResult> {
  const ids = await applicationsOfPerson(o.tenantId, o.candidateId, o.scope ?? {});
  const erase = (candidateId: string) => eraseOrSkip({ tenantId: o.tenantId, actorId: o.actorId, reason: o.reason, candidateId });
  // One at a time: each erasure is its own transaction and vendor clean-up,
  // exactly as a single erasure runs.
  let outcomes: readonly { readonly id: string; readonly outcome: Outcome }[] = [];
  for (const id of ids.filter((id) => id !== o.candidateId)) {
    outcomes = [...outcomes, { id, outcome: await erase(id) }];
  }
  // The requested record goes last, and only once every other application is
  // gone or held: it is what a retry starts from, so a part-way failure (or a
  // crash) always leaves a way back to the applications still to erase.
  if (outcomes.every((r) => r.outcome !== 'failed')) {
    outcomes = [...outcomes, { id: o.candidateId, outcome: await erase(o.candidateId) }];
  }
  const erasedIds = outcomes.filter((r) => r.outcome === 'erased').map((r) => r.id);
  const skippedIds = outcomes.filter((r) => r.outcome === 'held').map((r) => r.id);
  const failedIds = outcomes.filter((r) => r.outcome === 'failed').map((r) => r.id);

  // Ids and counts only: like candidate.erased, the free-text reason is not kept.
  await logAudit({
    tenantId: o.tenantId,
    actorType: 'user',
    actorId: o.actorId,
    action: 'candidate.erased_all_applications',
    entityType: 'Candidate',
    entityId: o.candidateId,
    after: {
      reasonProvided: o.reason.trim().length > 0, erasedCount: erasedIds.length, skippedCount: skippedIds.length, failedCount: failedIds.length,
      erasedIds, skippedIds, failedIds,
    },
  });
  logger.info({ candidateId: o.candidateId, erased: erasedIds.length, skipped: skippedIds.length, failed: failedIds.length }, 'Person erased across applications');

  return {
    candidateId: o.candidateId,
    erased: erasedIds.includes(o.candidateId),
    erasedIds,
    skipped: skippedIds.map((candidateId) => ({ candidateId, reason: 'legal_hold' as const })),
    failed: failedIds.map((candidateId) => ({ candidateId })),
    erasedAt: new Date().toISOString(),
  };
}
