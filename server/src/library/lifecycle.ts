import { prisma } from '../db.js';
import { config } from '../config.js';
import { logAudit } from '../services/audit.js';
import { logger } from '../logger.js';
import { isReservedEntryId, type EntryStatus, type LibraryPolicySettings } from './types.js';

/**
 * The entry lifecycle: draft → probational → live → retired, with rejected as
 * the other exit. Forward-only, nothing deleted. Every change writes a
 * LibraryReview row and an audit event naming the actor.
 */

export const TRANSITIONS: Readonly<Record<EntryStatus, readonly EntryStatus[]>> = {
  draft: ['probational', 'rejected', 'retired'],
  probational: ['live', 'rejected', 'retired'],
  live: ['retired'],
  retired: [],
  rejected: [],
};

export function canTransition(from: EntryStatus, to: EntryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertEntryId(id: string): void {
  if (isReservedEntryId(id)) throw new Error(`Entry id "${id}" is reserved for the engine's own blocks.`);
}

export type LifecycleActor = 'policy' | 'owner' | 'worker' | 'org user' | 'trial';

export interface TransitionContext {
  readonly actor: LifecycleActor;
  readonly actorId?: string;
  /** The actor's organisation, for the audit log; global entries fall back to the operator's. */
  readonly actorTenantId?: string;
  readonly action: string;
  readonly reason?: string;
  readonly sampleStratum?: string;
}

/** Non-answer rate above this is a spike: the question is confusing candidates, not measuring them. */
const NON_ANSWER_SPIKE = 0.25;

export function promotionDecision(opts: { readonly uses: readonly { readonly outcome: string }[]; readonly policy: LibraryPolicySettings }): { readonly promote: boolean; readonly reason: string } {
  const counted = opts.uses.filter((u) => u.outcome !== 'skipped');
  const nonAnswers = counted.filter((u) => u.outcome === 'non-answer').length;
  if (counted.length > 0 && nonAnswers / counted.length > NON_ANSWER_SPIKE) return { promote: false, reason: 'non_answer_spike' };
  const clean = counted.length - nonAnswers;
  if (clean < opts.policy.promotionUses) return { promote: false, reason: `uses ${clean}/${opts.policy.promotionUses}` };
  return { promote: true, reason: `uses ${clean}/${opts.policy.promotionUses}` };
}

// --- Persistence -------------------------------------------------------------

let operatorTenantCache: { readonly id: string | null; readonly at: number } | null = null;
const OPERATOR_TENANT_TTL_MS = 5 * 60_000;

/**
 * The tenant an audit event for a global entry is filed under: the platform
 * operator's organisation. AuditEvent requires a tenant, and the shared
 * library belongs to the owner, so that is where its history goes.
 */
export async function operatorTenantId(): Promise<string | null> {
  if (operatorTenantCache && Date.now() - operatorTenantCache.at < OPERATOR_TENANT_TTL_MS) return operatorTenantCache.id;
  const emails = config.platformOperatorEmails;
  const user = emails.length === 0 ? null : await prisma.user.findFirst({ where: { email: { in: emails } }, select: { tenantId: true } });
  operatorTenantCache = { id: user?.tenantId ?? null, at: Date.now() };
  return operatorTenantCache.id;
}

export function _resetLifecycleCacheForTest(): void {
  operatorTenantCache = null;
}

async function audit(entry: { readonly id: string; readonly tenantId: string | null }, ctx: TransitionContext, change: { readonly from: string; readonly to: string }): Promise<void> {
  const tenantId = entry.tenantId ?? ctx.actorTenantId ?? (await operatorTenantId());
  if (!tenantId) {
    logger.warn({ entryId: entry.id, action: ctx.action }, 'Library change has no tenant to audit under (no platform operator account yet)');
    return;
  }
  await logAudit({
    tenantId, actorId: ctx.actorId ?? ctx.actor, actorType: ctx.actor === 'owner' || ctx.actor === 'org user' ? 'user' : 'system',
    action: `library.entry.${ctx.action}`, entityType: 'LibraryEntry', entityId: entry.id,
    before: { status: change.from }, after: { status: change.to, reason: ctx.reason ?? '', actor: ctx.actor },
  });
}

export type TransitionResult = { readonly ok: true; readonly from: EntryStatus } | { readonly ok: false; readonly code: 'not_found' | 'invalid_transition' };

/**
 * Move an entry to `to` if the lifecycle allows it. The conditional update is
 * the guard: two owners deciding the same entry at once cannot both win.
 */
export async function transitionEntry(entryId: string, to: EntryStatus, ctx: TransitionContext, extra: { readonly gateReason?: string } = {}): Promise<TransitionResult> {
  assertEntryId(entryId);
  const entry = await prisma.libraryEntry.findUnique({ where: { id: entryId }, select: { id: true, status: true, tenantId: true, stratumKey: true } });
  if (!entry) return { ok: false, code: 'not_found' };
  const from = entry.status as EntryStatus;
  if (!canTransition(from, to)) return { ok: false, code: 'invalid_transition' };
  const moved = await prisma.libraryEntry.updateMany({
    where: { id: entryId, status: from },
    data: { status: to, ...(extra.gateReason !== undefined ? { gateReason: extra.gateReason } : {}) },
  });
  if (moved.count !== 1) return { ok: false, code: 'invalid_transition' };
  await prisma.libraryReview.create({
    data: {
      entryId, actor: ctx.actor, actorId: ctx.actorId ?? '', action: ctx.action, fromStatus: from, toStatus: to,
      reason: (ctx.reason ?? '').slice(0, 1000), sampleStratum: ctx.sampleStratum ?? '',
    },
  });
  await audit(entry, ctx, { from, to });
  return { ok: true, from };
}

/** A note on an entry that does not change its status (a sample draw, an owner comment). */
export async function recordReview(entryId: string, ctx: TransitionContext): Promise<void> {
  const entry = await prisma.libraryEntry.findUnique({ where: { id: entryId }, select: { status: true } });
  if (!entry) return;
  await prisma.libraryReview.create({
    data: { entryId, actor: ctx.actor, actorId: ctx.actorId ?? '', action: ctx.action, fromStatus: entry.status, toStatus: entry.status, reason: (ctx.reason ?? '').slice(0, 1000), sampleStratum: ctx.sampleStratum ?? '' },
  });
}

/**
 * Promote a probational entry once it has enough clean uses. Nothing produces
 * usage rows in L0; the function exists so L1 has the rule ready and tested.
 */
export async function promoteIfEligible(entryId: string, policy: LibraryPolicySettings): Promise<{ readonly promoted: boolean; readonly reason: string }> {
  const entry = await prisma.libraryEntry.findUnique({ where: { id: entryId }, select: { status: true } });
  if (!entry || entry.status !== 'probational') return { promoted: false, reason: 'not_probational' };
  const uses = await prisma.libraryUsage.findMany({ where: { entryId }, select: { outcome: true } });
  const decision = promotionDecision({ uses, policy });
  if (!decision.promote) return { promoted: false, reason: decision.reason };
  const result = await transitionEntry(entryId, 'live', { actor: 'policy', action: 'promoted', reason: decision.reason });
  return { promoted: result.ok, reason: decision.reason };
}

/**
 * Edit = a new draft that supersedes the old entry, which is retired. The
 * chain is what lets a transcript resolve the question it actually asked, and
 * what the select rule uses to treat the whole chain as one question.
 */
export async function supersedeEntry(entryId: string, edit: { readonly questionText: string; readonly form?: string; readonly difficultyTag?: number }, ctx: TransitionContext): Promise<{ readonly ok: true; readonly newId: string } | { readonly ok: false; readonly code: 'not_found' | 'invalid_transition' }> {
  const old = await prisma.libraryEntry.findUnique({ where: { id: entryId } });
  if (!old) return { ok: false, code: 'not_found' };
  const retired = await transitionEntry(entryId, 'retired', { ...ctx, action: 'superseded' });
  if (!retired.ok) return retired;
  const { id: _id, createdAt: _c, updatedAt: _u, status: _s, gateOutcome: _g, gateReason: _r, sampledOn: _sampled, ...rest } = old;
  const created = await prisma.libraryEntry.create({
    data: {
      ...rest,
      questionText: edit.questionText,
      form: edit.form ?? old.form,
      difficultyTag: edit.difficultyTag ?? old.difficultyTag,
      status: 'draft',
      // Edited by a person: the critic never saw this wording, so it waits for the owner.
      gateOutcome: 'unsure',
      gateReason: 'edited',
      supersedesId: old.id,
      createdBy: ctx.actorId ?? ctx.actor,
    },
  });
  await prisma.libraryReview.create({ data: { entryId: created.id, actor: ctx.actor, actorId: ctx.actorId ?? '', action: 'created_from_edit', fromStatus: '', toStatus: 'draft', reason: `supersedes ${old.id}` } });
  await audit(created, { ...ctx, action: 'created_from_edit' }, { from: '', to: 'draft' });
  return { ok: true, newId: created.id };
}
