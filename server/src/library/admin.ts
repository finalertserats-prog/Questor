import { prisma } from '../db.js';
import { config } from '../config.js';
import { formMixSatisfied, poolHealth, type PoolHealth } from './poolTargets.js';
import { loadPolicy, loadStratum, saveStratum, stratumAfterApproval, stratumAfterRejection } from './policy.js';
import { recordReview, supersedeEntry, transitionEntry, type TransitionResult } from './lifecycle.js';
import { lintQuestionText } from './linter.js';
import { todaysSample } from './sample.js';
import { budgetStatus } from './budget.js';
import { getWorkerStatus } from './workerState.js';
import { parseCriticVerdict, parseEntryBody, questionFormSchema, type EntryStatus } from './types.js';

/**
 * What the owner's admin screen reads and does. Platform-operator only (the
 * router enforces it); nothing here is tenant data. Decisions go through the
 * lifecycle module so every one leaves a review row and an audit event.
 */

export interface PoolHealthRow {
  readonly roleSlug: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly target: number;
  readonly live: number;
  readonly probational: number;
  readonly queued: number;
  readonly rejected: number;
  readonly retired: number;
  readonly health: PoolHealth;
  readonly formMix: Readonly<Record<string, number>>;
  readonly formMixOk: boolean;
}

export async function poolHealthRows(): Promise<PoolHealthRow[]> {
  const [rows, targets] = await Promise.all([
    prisma.libraryEntry.groupBy({ by: ['roleSlug', 'competencyKey', 'band', 'status', 'form', 'gateOutcome'], where: { scope: 'global' }, _count: { _all: true } }),
    prisma.libraryPoolTarget.findMany({ where: { scope: 'global' }, select: { roleSlug: true, competencyKey: true, band: true, depthTarget: true } }),
  ]);
  const targetOf = new Map(targets.map((t) => [`${t.roleSlug}|${t.competencyKey}|${t.band}`, t.depthTarget]));
  const pools = new Map<string, { live: number; probational: number; queued: number; rejected: number; retired: number; formMix: Record<string, number> }>();
  for (const row of rows) {
    const key = `${row.roleSlug}|${row.competencyKey}|${row.band}`;
    const p = pools.get(key) ?? { live: 0, probational: 0, queued: 0, rejected: 0, retired: 0, formMix: {} };
    const n = row._count._all;
    const next = { ...p, formMix: { ...p.formMix } };
    if (row.status === 'live') { next.live += n; next.formMix[row.form] = (next.formMix[row.form] ?? 0) + n; }
    else if (row.status === 'probational') { next.probational += n; next.formMix[row.form] = (next.formMix[row.form] ?? 0) + n; }
    else if (row.status === 'draft' && row.gateOutcome === 'unsure') next.queued += n;
    else if (row.status === 'rejected') next.rejected += n;
    else if (row.status === 'retired') next.retired += n;
    pools.set(key, next);
  }
  for (const key of targetOf.keys()) if (!pools.has(key)) pools.set(key, { live: 0, probational: 0, queued: 0, rejected: 0, retired: 0, formMix: {} });
  return [...pools.entries()].map(([key, p]) => {
    const [roleSlug, competencyKey, band] = key.split('|');
    const target = targetOf.get(key) ?? 0;
    return { roleSlug, competencyKey, band, target, ...p, health: poolHealth({ live: p.live, target: Math.max(1, target) }), formMixOk: formMixSatisfied(p.formMix).ok };
  }).sort((a, b) => a.roleSlug.localeCompare(b.roleSlug) || a.competencyKey.localeCompare(b.competencyKey) || a.band.localeCompare(b.band));
}

export interface EntryView {
  readonly id: string;
  readonly scope: string;
  readonly roleSlug: string;
  readonly familySlug: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly form: string;
  readonly questionText: string;
  readonly anchors: readonly string[];
  readonly rationale: string;
  readonly status: string;
  readonly gateOutcome: string;
  readonly gateReasons: readonly string[];
  readonly stratumKey: string;
  readonly difficultyTag: number;
  readonly supersedesId: string | null;
  readonly generatorPromptVersion: string;
  readonly generatorModel: string;
  readonly criticModel: string;
  readonly criticVerdict: ReturnType<typeof parseCriticVerdict>;
  readonly policyVersion: number;
  readonly sampledOn: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type EntryRow = NonNullable<Awaited<ReturnType<typeof prisma.libraryEntry.findUnique>>>;

export function entryView(row: EntryRow): EntryView {
  const body = parseEntryBody(row.bodyJson);
  return {
    id: row.id, scope: row.scope, roleSlug: row.roleSlug, familySlug: row.familySlug, competencyKey: row.competencyKey, band: row.band, form: row.form,
    questionText: row.questionText, anchors: body.anchors, rationale: body.rationale ?? '', status: row.status, gateOutcome: row.gateOutcome,
    gateReasons: row.gateReason ? row.gateReason.split(',') : [], stratumKey: row.stratumKey, difficultyTag: row.difficultyTag, supersedesId: row.supersedesId,
    generatorPromptVersion: row.generatorPromptVersion, generatorModel: row.generatorModel, criticModel: row.criticModel,
    criticVerdict: parseCriticVerdict(row.criticVerdictJson), policyVersion: row.policyVersion, sampledOn: row.sampledOn,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export const QUEUE_PAGE = 50;

/** The owner queue: drafts the gate was unsure about, oldest first. */
export async function ownerQueue(opts: { readonly roleSlug?: string; readonly page: number; readonly limit: number }): Promise<{ readonly entries: EntryView[]; readonly total: number }> {
  const where = { status: 'draft', gateOutcome: 'unsure', ...(opts.roleSlug ? { roleSlug: opts.roleSlug } : {}) };
  const [rows, total] = await Promise.all([
    prisma.libraryEntry.findMany({ where, orderBy: { createdAt: 'asc' }, skip: (opts.page - 1) * opts.limit, take: opts.limit }),
    prisma.libraryEntry.count({ where }),
  ]);
  return { entries: rows.map(entryView), total };
}

export async function sampleEntries(now = new Date()): Promise<EntryView[]> {
  const policy = await loadPolicy();
  const ids = await todaysSample(policy.sampleSize, now);
  if (ids.length === 0) return [];
  const rows = await prisma.libraryEntry.findMany({ where: { id: { in: ids } } });
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map(entryView);
}

export async function entryWithHistory(id: string) {
  const row = await prisma.libraryEntry.findUnique({ where: { id } });
  if (!row) return null;
  const [reviews, standard, successor] = await Promise.all([
    prisma.libraryReview.findMany({ where: { entryId: id }, orderBy: { at: 'asc' } }),
    row.standardId ? prisma.libraryStandard.findUnique({ where: { id: row.standardId }, select: { id: true, version: true, anchorsJson: true } }) : null,
    prisma.libraryEntry.findFirst({ where: { supersedesId: id }, select: { id: true, status: true } }),
  ]);
  return {
    entry: entryView(row),
    history: reviews.map((r) => ({ id: r.id, actor: r.actor, actorId: r.actorId, action: r.action, fromStatus: r.fromStatus, toStatus: r.toStatus, reason: r.reason, at: r.at.toISOString() })),
    standard: standard ? { id: standard.id, version: standard.version } : null,
    supersededBy: successor,
  };
}

export interface StratumRates {
  readonly stratumKey: string;
  readonly total: number;
  readonly probational: number;
  readonly live: number;
  readonly rejected: number;
  readonly queued: number;
  readonly cleanApprovals: number;
  readonly tightenedRemaining: number;
  readonly promotionRate: number;
  readonly rejectionRate: number;
}

export async function ratesByStratum(): Promise<StratumRates[]> {
  const [rows, strata] = await Promise.all([
    prisma.libraryEntry.groupBy({ by: ['stratumKey', 'status', 'gateOutcome'], _count: { _all: true } }),
    prisma.libraryStratum.findMany(),
  ]);
  const gate = new Map(strata.map((s) => [s.key, s]));
  const acc = new Map<string, { total: number; probational: number; live: number; rejected: number; queued: number }>();
  for (const row of rows) {
    const a = acc.get(row.stratumKey) ?? { total: 0, probational: 0, live: 0, rejected: 0, queued: 0 };
    const n = row._count._all;
    acc.set(row.stratumKey, {
      total: a.total + n,
      probational: a.probational + (row.status === 'probational' ? n : 0),
      live: a.live + (row.status === 'live' ? n : 0),
      rejected: a.rejected + (row.status === 'rejected' ? n : 0),
      queued: a.queued + (row.status === 'draft' && row.gateOutcome === 'unsure' ? n : 0),
    });
  }
  return [...acc.entries()].map(([stratumKey, a]) => ({
    stratumKey, ...a,
    cleanApprovals: gate.get(stratumKey)?.cleanApprovals ?? 0,
    tightenedRemaining: gate.get(stratumKey)?.tightenedRemaining ?? 0,
    promotionRate: a.total === 0 ? 0 : (a.probational + a.live) / a.total,
    rejectionRate: a.total === 0 ? 0 : a.rejected / a.total,
  })).sort((a, b) => a.stratumKey.localeCompare(b.stratumKey));
}

export async function overview(now = new Date()) {
  const [worker, budget, policy, counts, queueTotal] = await Promise.all([
    getWorkerStatus(),
    budgetStatus({ dailyCap: config.library.dailyCallCap, monthlyCap: config.library.monthlyTokenCap }, now),
    loadPolicy(),
    prisma.libraryEntry.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.libraryEntry.count({ where: { status: 'draft', gateOutcome: 'unsure' } }),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<EntryStatus, number>>;
  return {
    enabled: config.library.enabled,
    workerEnabled: config.library.workerEnabled,
    critic: { provider: config.library.criticProvider, model: config.library.criticModel, configured: config.library.criticProvider === 'anthropic' ? config.llm.anthropicKey.length > 0 : config.llm.openaiKey.length > 0 },
    worker: { ...worker, since: worker.since.toISOString(), lastBatchAt: worker.lastBatchAt?.toISOString() ?? null, updatedAt: worker.updatedAt.toISOString() },
    budget,
    policy,
    counts: byStatus,
    queueTotal,
  };
}

// --- Decisions -------------------------------------------------------------------

export interface Owner {
  readonly userId: string;
  readonly tenantId: string;
}

async function bumpStratum(stratumKey: string, change: 'approve' | 'reject'): Promise<void> {
  if (!stratumKey) return;
  const state = await loadStratum(stratumKey);
  const policy = await loadPolicy();
  await saveStratum(stratumKey, change === 'approve' ? stratumAfterApproval(state, true) : stratumAfterRejection(state, policy));
}

export async function approveEntry(id: string, owner: Owner, note: string): Promise<TransitionResult> {
  const entry = await prisma.libraryEntry.findUnique({ where: { id }, select: { stratumKey: true, gateReason: true } });
  if (!entry) return { ok: false, code: 'not_found' };
  const result = await transitionEntry(id, 'probational', { actor: 'owner', actorId: owner.userId, actorTenantId: owner.tenantId, action: 'approved', reason: note, sampleStratum: entry.stratumKey });
  // Counted for the owner's rates by stratum; an edited draft is not a clean
  // approval (the critic never saw that wording). The count no longer gates.
  if (result.ok && entry.gateReason !== 'edited') await bumpStratum(entry.stratumKey, 'approve');
  return result;
}

/** A rejection from the daily sample also tightens the stratum's gate. */
export async function rejectEntry(id: string, owner: Owner, reason: string): Promise<TransitionResult> {
  const entry = await prisma.libraryEntry.findUnique({ where: { id }, select: { stratumKey: true, sampledOn: true, status: true } });
  if (!entry) return { ok: false, code: 'not_found' };
  const target: EntryStatus = entry.status === 'live' ? 'retired' : 'rejected';
  const result = await transitionEntry(id, target, { actor: 'owner', actorId: owner.userId, actorTenantId: owner.tenantId, action: 'rejected', reason, sampleStratum: entry.stratumKey });
  if (result.ok && entry.sampledOn) await bumpStratum(entry.stratumKey, 'reject');
  return result;
}

export async function retireEntry(id: string, owner: Owner, reason: string): Promise<TransitionResult> {
  return transitionEntry(id, 'retired', { actor: 'owner', actorId: owner.userId, actorTenantId: owner.tenantId, action: 'retired', reason });
}

export type EditResult = { readonly ok: true; readonly newId: string } | { readonly ok: false; readonly code: 'not_found' | 'invalid_transition' | 'lint'; readonly problems?: readonly string[] };

/** Edit = new draft superseding the old; the edited text passes the linter first. */
export async function editEntry(id: string, owner: Owner, edit: { readonly questionText: string; readonly form?: string; readonly difficultyTag?: number }): Promise<EditResult> {
  const lint = lintQuestionText(edit.questionText);
  if (!lint.ok) return { ok: false, code: 'lint', problems: lint.errors.map((e) => `${e.code}: ${e.detail}`) };
  const form = edit.form !== undefined ? questionFormSchema.safeParse(edit.form) : null;
  const result = await supersedeEntry(id, { questionText: edit.questionText.trim(), form: form?.success ? form.data : undefined, difficultyTag: edit.difficultyTag }, { actor: 'owner', actorId: owner.userId, actorTenantId: owner.tenantId, action: 'edited' });
  return result;
}

export async function noteEntry(id: string, owner: Owner, note: string): Promise<void> {
  await recordReview(id, { actor: 'owner', actorId: owner.userId, actorTenantId: owner.tenantId, action: 'noted', reason: note });
}
