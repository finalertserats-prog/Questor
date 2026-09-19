import { prisma } from '../db.js';
import { config } from '../config.js';
import type { CatalogCandidate } from '../domain/catalogMatch.js';
import { acceptDrafts, capOverflow, draftsForCandidate, type ProposalDraft } from '../domain/catalogProposalPlan.js';
import { classifyTitles, type ClassificationModel } from './catalogClassify.js';
import type { RunContext } from './catalogRefreshContext.js';
import { bumpSourceStats, SOURCE_KEYS, type RefreshCursor, type RefreshStats, type SourceKey } from './catalogRefreshState.js';

/**
 * One chunk of candidates → proposals in the review queue. Every chunk ends
 * with the run's cap enforced over everything it has queued so far, so the cap
 * is global to the run however many chunks and sources feed it.
 */

export interface RunState {
  readonly cursor: RefreshCursor;
  readonly stats: RefreshStats;
  readonly llmCalls: number;
  readonly researchCalls: number;
  /** Normalised titles pending, recently rejected, or already proposed in this run. */
  readonly blocked: ReadonlySet<string>;
}

export interface ChunkModel {
  readonly model: ClassificationModel;
  readonly modelAvailable: boolean;
}

async function classifyDrafts(ctx: RunContext, state: RunState, drafts: readonly ProposalDraft[], model: ChunkModel): Promise<{ drafts: ProposalDraft[]; modelCalls: number }> {
  const unclassified = drafts.filter((d) => d.kind === 'new_role' && d.domainId === null);
  if (unclassified.length === 0) return { drafts: [...drafts], modelCalls: 0 };
  const { byTitle, modelCalls } = await classifyTitles(unclassified.map((d) => ({ title: d.title, description: d.summary || undefined })), {
    index: ctx.index,
    allowed: ctx.allowed,
    names: ctx.names,
    model: model.model,
    modelAvailable: model.modelAvailable,
    maxCalls: Math.max(0, config.catalogRefresh.maxLlmCalls - state.llmCalls),
  });
  const classified = drafts.map((draft) => {
    const found = draft.kind === 'new_role' && draft.domainId === null ? byTitle.get(draft.normalizedTitle) : undefined;
    return found ? { ...draft, domainId: found.domainId, familyId: found.familyId, confidence: found.confidence } : draft;
  });
  return { drafts: classified, modelCalls };
}

async function insertProposals(runId: string, drafts: readonly ProposalDraft[]): Promise<void> {
  if (drafts.length === 0) return;
  await prisma.catalogProposal.createMany({
    data: drafts.map((d) => ({
      runId, kind: d.kind, status: 'pending', title: d.title, normalizedTitle: d.normalizedTitle, domainId: d.domainId, familyId: d.familyId,
      summary: d.summary, targetRoleId: d.targetRoleId, sourcesJson: JSON.stringify(d.sources), confidence: d.confidence,
    })),
  });
}

function firstSource(sourcesJson: string): SourceKey | null {
  try {
    const parsed: unknown = JSON.parse(sourcesJson);
    const source = Array.isArray(parsed) && typeof parsed[0] === 'object' && parsed[0] !== null ? (parsed[0] as { source?: unknown }).source : null;
    return SOURCE_KEYS.find((key) => key === source) ?? null;
  } catch { return null; }
}

/** Remove this run's pending proposals beyond the cap; returns how many per source. */
export async function enforceRunCap(runId: string, max: number): Promise<Partial<Record<SourceKey, number>>> {
  const rows = await prisma.catalogProposal.findMany({ where: { runId, status: 'pending' }, select: { id: true, kind: true, confidence: true, createdAt: true, sourcesJson: true } });
  const overflow = new Set(capOverflow(rows, max));
  if (overflow.size === 0) return {};
  await prisma.catalogProposal.deleteMany({ where: { id: { in: [...overflow] }, status: 'pending' } });
  return rows.filter((row) => overflow.has(row.id)).reduce<Partial<Record<SourceKey, number>>>((acc, row) => {
    const source = firstSource(row.sourcesJson);
    return source ? { ...acc, [source]: (acc[source] ?? 0) + 1 } : acc;
  }, {});
}

function applyTrim(stats: RefreshStats, trimmed: Partial<Record<SourceKey, number>>): RefreshStats {
  return Object.entries(trimmed).reduce((acc, [source, count]) => bumpSourceStats(acc, source as SourceKey, { proposed: -(count ?? 0), skipped: count ?? 0 }), stats);
}

/**
 * Skipped: unmatched candidates that did not become a new-role proposal
 * (no confident domain, a duplicate, an unusable title), plus alias drafts
 * refused as duplicates. Each unmatched candidate yields at most one role draft.
 */
function countSkipped(candidates: number, matched: number, drafts: readonly ProposalDraft[], accepted: readonly ProposalDraft[]): number {
  const acceptedRoles = accepted.filter((d) => d.kind === 'new_role').length;
  const refusedAliases = drafts.filter((d) => d.kind === 'new_alias').length - accepted.filter((d) => d.kind === 'new_alias').length;
  return candidates - matched - acceptedRoles + refusedAliases;
}

export async function processCandidates(
  ctx: RunContext,
  state: RunState,
  source: SourceKey,
  candidates: readonly CatalogCandidate[],
  model: ChunkModel,
  opts: { readonly aliasesOnly?: boolean } = {},
): Promise<RunState> {
  const plans = candidates.map((candidate) => draftsForCandidate(candidate, ctx.index, { aliasesOnly: opts.aliasesOnly }));
  const matchedExisting = plans.filter((plan) => plan.matchedExisting).length;
  const drafted = plans.flatMap((plan) => plan.drafts);
  const { drafts, modelCalls } = await classifyDrafts(ctx, state, drafted, model);
  const { accepted } = acceptDrafts(drafts, { known: ctx.index.known, blocked: state.blocked, minConfidence: config.catalogRefresh.minConfidence });
  await insertProposals(ctx.runId, accepted);
  const trimmed = await enforceRunCap(ctx.runId, config.catalogRefresh.maxProposals);
  const skipped = countSkipped(candidates.length, matchedExisting, drafts, accepted);
  const stats = applyTrim(bumpSourceStats(state.stats, source, { fetched: candidates.length, matchedExisting, proposed: accepted.length, skipped }), trimmed);
  return {
    ...state,
    stats,
    llmCalls: state.llmCalls + modelCalls,
    blocked: new Set([...state.blocked, ...accepted.map((d) => d.normalizedTitle)]),
  };
}
