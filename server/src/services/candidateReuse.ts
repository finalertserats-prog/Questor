import { Prisma, type Candidate } from '@prisma/client';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { DEFAULT_STAGES, parseStages } from '../domain/pipelineStages.js';
import { resolveTransition, type PipelineEvent, type StageTransition } from '../domain/pipelineAutonomy.js';
import { assertCanAccessCandidate, assertCanAccessRole, assignCandidate, candidateScope } from './access.js';
import { assertRoleOpen } from './roleOpen.js';
import { assertDemoCreationCap } from './demoAccess.js';
import { logAudit } from './audit.js';
import { emitEvent } from './webhooks.js';
import { normalizeEmail } from './userEmail.js';
import { resumeScoringFor, storeResumeProfile } from './resumeProfile.js';
import type { AuthClaims } from './auth.js';

/**
 * Candidate reuse: a person already in Questor is put forward for another
 * role without anyone typing their details again.
 *
 * A Candidate row stays "one person's application to one role" — access
 * scope, fit, pipeline and interviews all hang off that — so reuse never
 * moves or shares a row. It finds the person (by name or address, among the
 * rows the caller may already see) and copies them into a NEW row for the
 * other role. The copy is independent afterwards: nothing syncs back.
 */

export const CANDIDATE_SEARCH_MIN_CHARS = 2;
const PEOPLE_LIMIT = 10;
// Newest rows first; a person last seen further back than this is typed in again.
const SEARCH_ROW_LIMIT = 5000;

export interface CandidateRoleEntry {
  readonly candidateId: string;
  readonly roleId: string | null;
  readonly roleTitle: string | null;
  readonly roleLevel: string | null;
}

export interface CandidatePerson {
  /** The application to copy from: the newest one with a resume, else the newest. */
  readonly candidateId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly hasResume: boolean;
  /** Only the applications the caller may see. */
  readonly roles: readonly CandidateRoleEntry[];
}

interface SearchRow {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly emailNormalized: string;
  readonly phone: string;
  readonly roleId: string | null;
  readonly role: { readonly title: string; readonly level: string } | null;
  readonly _count: { readonly profiles: number };
}

/** Case-folded for comparison; locale-independent, as in roleSearch.ts. */
const fold = (text: string): string => text.normalize('NFKC').toLowerCase();

// A row written before emailNormalized existed may still hold the default.
const personKey = (row: Pick<SearchRow, 'email' | 'emailNormalized'>): string => row.emailNormalized || normalizeEmail(row.email);

function toPerson(rows: readonly SearchRow[]): CandidatePerson {
  const newest = rows[0];
  const source = rows.find((r) => r._count.profiles > 0) ?? newest;
  return {
    candidateId: source.id,
    fullName: newest.fullName,
    email: newest.email,
    phone: rows.find((r) => r.phone)?.phone ?? '',
    hasResume: source._count.profiles > 0,
    roles: rows.map((r) => ({ candidateId: r.id, roleId: r.roleId, roleTitle: r.role?.title ?? null, roleLevel: r.role?.level ?? null })),
  };
}

/**
 * People matching `query` by name or address, grouped by address.
 *
 * Only rows inside the caller's candidateScope are read, so a person who is
 * also in someone else's pipeline is found without that pipeline being
 * disclosed. Matched in application code rather than SQL for the reason
 * roleSearch.ts gives: case-insensitive LIKE differs between SQLite and
 * Postgres.
 */
export async function searchCandidatePeople(auth: AuthClaims, query: string): Promise<CandidatePerson[]> {
  const needle = fold(query.trim());
  const rows: SearchRow[] = await prisma.candidate.findMany({
    where: (await candidateScope(auth)) as Prisma.CandidateWhereInput,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SEARCH_ROW_LIMIT,
    select: {
      id: true, fullName: true, email: true, emailNormalized: true, phone: true, roleId: true,
      role: { select: { title: true, level: true } },
      _count: { select: { profiles: true } },
    },
  });
  const byPerson = rows.reduce((groups, row) => {
    const key = personKey(row);
    return groups.set(key, [...(groups.get(key) ?? []), row]);
  }, new Map<string, SearchRow[]>());
  return [...byPerson.entries()]
    .filter(([key, group]) => key.includes(needle) || group.some((r) => fold(r.fullName).includes(needle)))
    .slice(0, PEOPLE_LIMIT)
    .map(([, group]) => toPerson(group));
}

export type ApplyResult =
  | { readonly kind: 'created'; readonly candidate: Candidate; readonly profileCopied: boolean; readonly fit: unknown }
  | { readonly kind: 'exists'; readonly candidateId: string };

interface SourceResume {
  readonly rawText: string;
  readonly filename: string;
  readonly contentType: string;
}

/** The latest resume on the source application, if it has one worth copying. */
async function latestResume(candidateId: string): Promise<SourceResume | null> {
  const [profile, artifact] = await Promise.all([
    prisma.candidateProfileVersion.findFirst({ where: { candidateId }, orderBy: [{ createdAt: 'desc' }, { version: 'desc' }], select: { rawText: true } }),
    prisma.artifact.findFirst({ where: { candidateId, kind: 'resume' }, orderBy: { createdAt: 'desc' }, select: { filename: true, contentType: true } }),
  ]);
  if (!profile?.rawText.trim()) return null;
  return { rawText: profile.rawText, filename: artifact?.filename || 'resume.txt', contentType: artifact?.contentType || 'text/plain' };
}

/**
 * The new application's pipeline, created in the same transaction as the row
 * and already at the stage its events reach: Participation for a new
 * application, Bronze once its resume is analysed — where POST / and the
 * resume upload would have put it through notePipelineEvent.
 */
async function startPipeline(
  tx: Prisma.TransactionClient,
  o: { readonly tenantId: string; readonly candidateId: string; readonly roleId: string; readonly events: readonly PipelineEvent[] },
) {
  const role = await tx.role.findFirst({ where: { id: o.roleId, tenantId: o.tenantId }, select: { pipelineStagesJson: true } });
  const stages = role?.pipelineStagesJson ? parseStages(role.pipelineStagesJson) : DEFAULT_STAGES.map((s) => ({ ...s }));
  const moves = o.events.reduce<StageTransition[]>((done, event) => {
    const from = done.length ? done[done.length - 1].to : stages[0].key;
    const move = resolveTransition(stages, from, event);
    return move ? [...done, move] : done;
  }, []);
  const pipeline = await tx.candidatePipeline.create({
    data: {
      tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId,
      stagesJson: JSON.stringify(stages), currentStageKey: moves.length ? moves[moves.length - 1].to : stages[0].key,
    },
  });
  return { pipeline, stages, moves };
}

const isSerializationFailure = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';

// One retry: the transaction that lost a serialisation conflict usually lost
// it to the same apply, and on the retry its duplicate check sees that row.
const APPLY_ATTEMPTS = 2;

/**
 * Put the person behind `sourceId` forward for `roleId` as a new application.
 *
 * The duplicate check, the row, its owner and its pipeline commit together
 * under Serializable isolation: two identical applies at once cannot both
 * pass the check. The address is compared normalised, so the same mailbox in
 * different capitals is still one person.
 */
export async function applyCandidateToRole(auth: AuthClaims, sourceId: string, roleId: string): Promise<ApplyResult> {
  const source = await assertCanAccessCandidate(auth, sourceId);
  await assertDemoCreationCap(auth.tenantId, 'candidates');
  await assertCanAccessRole(auth, roleId);
  await assertRoleOpen(roleId);
  const emailNormalized = normalizeEmail(source.email);
  const resume = await latestResume(source.id);
  const scoring = resume ? await resumeScoringFor(roleId) : null;

  const attempt = () => prisma.$transaction(async (tx) => {
    const existing = await tx.candidate.findFirst({ where: { tenantId: auth.tenantId, roleId, emailNormalized }, select: { id: true } });
    if (existing) return { kind: 'exists' as const, candidateId: existing.id };
    const candidate = await tx.candidate.create({
      data: { tenantId: auth.tenantId, roleId, fullName: source.fullName, email: source.email, emailNormalized, phone: source.phone },
    });
    await assignCandidate(candidate.id, auth.userId, 'owner', tx);
    const stored = resume && scoring
      ? await storeResumeProfile(tx, { tenantId: auth.tenantId, candidateId: candidate.id, ...resume, scoring })
      : null;
    const events: PipelineEvent[] = stored ? ['candidate.onboarded', 'candidate.profiled'] : ['candidate.onboarded'];
    const started = await startPipeline(tx, { tenantId: auth.tenantId, candidateId: candidate.id, roleId, events });
    return { kind: 'created' as const, candidate, stored, started };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const outcome = await retryOnConflict(attempt);
  if (outcome.kind === 'exists') return outcome;
  await recordApplied(auth, source.id, outcome);
  return { kind: 'created', candidate: outcome.candidate, profileCopied: outcome.stored !== null, fit: outcome.stored?.fit ?? null };
}

async function retryOnConflict<T>(run: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (err) {
      if (!isSerializationFailure(err)) throw err;
      if (i >= APPLY_ATTEMPTS) throw new HttpError(409, 'This person was being added to that role at the same moment. Refresh and try again.');
    }
  }
}

/** The audit trail and webhook for a committed apply, in the order the single-step flows write them. */
async function recordApplied(
  auth: AuthClaims,
  sourceId: string,
  o: { readonly candidate: Candidate; readonly stored: { readonly fit: { readonly overall: number } } | null; readonly started: Awaited<ReturnType<typeof startPipeline>> },
): Promise<void> {
  const user = { tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user' as const, entityType: 'Candidate', entityId: o.candidate.id };
  await logAudit({ ...user, action: 'candidate.created', after: { copiedFromCandidateId: sourceId, roleId: o.candidate.roleId } });
  const { pipeline, stages, moves } = o.started;
  await logAudit({
    tenantId: auth.tenantId, actorType: 'system', action: 'pipeline.created', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { candidateId: o.candidate.id, roleId: pipeline.roleId, stages: stages.map((s) => s.key), trigger: 'candidate.created' },
  });
  if (o.stored) {
    await logAudit({ ...user, action: 'candidate.parsed' });
    await emitEvent(auth.tenantId, 'candidate.parsed', { candidateId: o.candidate.id, fit: o.stored.fit.overall });
  }
  for (const move of moves) {
    await logAudit({
      tenantId: auth.tenantId, actorType: 'system', action: 'pipeline.auto_advanced', entityType: 'CandidatePipeline', entityId: pipeline.id,
      before: { stage: move.from }, after: { stage: move.to, trigger: 'candidate.applied' },
    });
  }
}
