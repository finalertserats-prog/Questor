import { prisma } from '../db.js';
import { config } from '../config.js';
import type { CatalogCandidate } from '../domain/catalogMatch.js';
import { acceptDrafts, draftsForCandidate, type ProposalDraft } from '../domain/catalogProposalPlan.js';
import { classifyTitles, type ClassificationModel } from './catalogClassify.js';
import type { RunContext } from './catalogRefreshContext.js';
import { bumpSourceStats, type RefreshCursor, type RefreshStats, type SourceKey } from './catalogRefreshState.js';

/**
 * One chunk of candidates → proposals in the review queue.
 *
 * The per-run cap is enforced BEFORE anything is inserted, from the counts
 * the run has already queued: a proposal the owner may be looking at is never
 * removed again. Alternative titles may take only part of the cap, so new
 * roles always get room; within a chunk the most confident go first.
 */

export interface RunState {
  readonly cursor: RefreshCursor;
  readonly stats: RefreshStats;
  readonly llmCalls: number;
  readonly researchCalls: number;
  /** Normalised titles pending, recently rejected, or already proposed in this run. */
  readonly blocked: ReadonlySet<string>;
  /** What this run has queued so far, for the cap. */
  readonly queued: { readonly aliases: number; readonly roles: number };
}

export interface ChunkModel {
  readonly model: ClassificationModel;
  readonly modelAvailable: boolean;
}

function byConfidence(a: ProposalDraft, b: ProposalDraft): number {
  return b.confidence - a.confidence;
}

async function classifyRoleDrafts(ctx: RunContext, state: RunState, drafts: readonly ProposalDraft[], model: ChunkModel): Promise<{ drafts: ProposalDraft[]; modelCalls: number }> {
  const unclassified = drafts.filter((d) => d.domainId === null);
  if (unclassified.length === 0) return { drafts: [...drafts], modelCalls: 0 };
  const { byTitle, modelCalls } = await classifyTitles(unclassified.map((d) => ({ title: d.title, description: d.summary || undefined })), {
    index: ctx.index,
    allowed: ctx.allowed,
    names: ctx.names,
    model: model.model,
    modelAvailable: model.modelAvailable,
    maxCalls: Math.max(0, ctx.limits.llmCalls - state.llmCalls),
  });
  const classified = drafts.map((draft) => {
    const found = draft.domainId === null ? byTitle.get(draft.normalizedTitle) : undefined;
    return found ? { ...draft, domainId: found.domainId, familyId: found.familyId, confidence: found.confidence } : draft;
  });
  return { drafts: classified, modelCalls };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { readonly code?: string }).code === 'P2002';
}

function rowOf(runId: string, d: ProposalDraft) {
  return {
    runId, kind: d.kind, status: 'pending', title: d.title, normalizedTitle: d.normalizedTitle, domainId: d.domainId, familyId: d.familyId,
    summary: d.summary, targetRoleId: d.targetRoleId, sourcesJson: JSON.stringify(d.sources), confidence: d.confidence,
  };
}

/**
 * Insert, returning what was actually inserted. A unique index on pending
 * proposals (Postgres) is the backstop against a second writer; a clash means
 * someone queued the same title meanwhile, which is a skip, not a failure.
 */
async function insertProposals(runId: string, drafts: readonly ProposalDraft[]): Promise<ProposalDraft[]> {
  if (drafts.length === 0) return [];
  try {
    await prisma.catalogProposal.createMany({ data: drafts.map((d) => rowOf(runId, d)) });
    return [...drafts];
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const inserted: ProposalDraft[] = [];
  for (const draft of drafts) {
    try {
      await prisma.catalogProposal.create({ data: rowOf(runId, draft) });
      inserted.push(draft);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return inserted;
}

interface Room {
  readonly aliases: number;
  readonly total: number;
}

function roomLeft(state: RunState): Room {
  const max = config.catalogRefresh.maxProposals;
  const aliasCap = Math.floor(max * config.catalogRefresh.maxAliasShare);
  const total = Math.max(0, max - state.queued.aliases - state.queued.roles);
  return { aliases: Math.min(total, Math.max(0, aliasCap - state.queued.aliases)), total };
}

/** The drafts that fit, aliases first; new roles are classified only if room is left for them. */
async function selectDrafts(ctx: RunContext, state: RunState, drafted: readonly ProposalDraft[], model: ChunkModel) {
  const room = roomLeft(state);
  const rules = { known: ctx.index.known, blocked: state.blocked, minConfidence: config.catalogRefresh.minConfidence };
  const aliases = acceptDrafts(drafted.filter((d) => d.kind === 'new_alias'), rules).accepted.sort(byConfidence).slice(0, room.aliases);
  const roleRoom = room.total - aliases.length;
  const roleDrafts = drafted.filter((d) => d.kind === 'new_role');
  if (roleRoom <= 0 || roleDrafts.length === 0) return { selected: aliases, modelCalls: 0 };
  // Classify only titles that could still be queued: a full run spends nothing.
  const candidates = roleDrafts.filter((d) => !ctx.index.known.has(d.normalizedTitle) && !state.blocked.has(d.normalizedTitle));
  const { drafts, modelCalls } = await classifyRoleDrafts(ctx, state, candidates, model);
  const blocked = new Set([...state.blocked, ...aliases.map((d) => d.normalizedTitle)]);
  const roles = acceptDrafts(drafts, { ...rules, blocked }).accepted.sort(byConfidence).slice(0, roleRoom);
  return { selected: [...aliases, ...roles], modelCalls };
}

/**
 * Skipped: unmatched candidates that did not become a new-role proposal (no
 * confident domain, a duplicate, an unusable title, no room), plus alias
 * drafts not queued. Each unmatched candidate yields at most one role draft.
 */
function countSkipped(candidates: number, matched: number, drafted: readonly ProposalDraft[], inserted: readonly ProposalDraft[]): number {
  const insertedRoles = inserted.filter((d) => d.kind === 'new_role').length;
  const refusedAliases = drafted.filter((d) => d.kind === 'new_alias').length - inserted.filter((d) => d.kind === 'new_alias').length;
  return candidates - matched - insertedRoles + refusedAliases;
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
  const { selected, modelCalls } = await selectDrafts(ctx, state, drafted, model);
  const inserted = await insertProposals(ctx.runId, selected);
  const skipped = countSkipped(candidates.length, matchedExisting, drafted, inserted);
  const insertedAliases = inserted.filter((d) => d.kind === 'new_alias').length;
  return {
    ...state,
    stats: bumpSourceStats(state.stats, source, { fetched: candidates.length, matchedExisting, proposed: inserted.length, skipped }),
    llmCalls: state.llmCalls + modelCalls,
    // Every selected title is blocked for the rest of the run, including one a
    // concurrent writer beat us to: it is pending either way.
    blocked: new Set([...state.blocked, ...selected.map((d) => d.normalizedTitle)]),
    queued: { aliases: state.queued.aliases + insertedAliases, roles: state.queued.roles + inserted.length - insertedAliases },
  };
}
