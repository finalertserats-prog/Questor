import { catalogTitleProblem, normalizeTitle } from './catalogText.js';
import { matchOccupation, trimCandidateSummary, type CatalogCandidate, type CatalogIndex, type CatalogSourceName } from './catalogMatch.js';

/**
 * Turning matched occupations into review-queue proposals, and deciding which
 * proposals are worth the owner's time. Pure, so the queue's rules (dedupe,
 * thresholds, the per-run cap) are pinned by unit tests.
 */

export type ProposalKind = 'new_role' | 'new_alias';

export interface ProposalSourceRef {
  readonly source: CatalogSourceName;
  readonly ref: string;
  readonly url?: string;
  readonly label?: string;
}

export interface ProposalDraft {
  readonly kind: ProposalKind;
  readonly title: string;
  readonly normalizedTitle: string;
  readonly domainId: string | null;
  readonly familyId: string | null;
  readonly summary: string;
  readonly targetRoleId: string | null;
  readonly sources: readonly ProposalSourceRef[];
  readonly confidence: number;
}

export interface CandidatePlan {
  readonly matchedExisting: boolean;
  readonly drafts: readonly ProposalDraft[];
}

// An alias from a matched occupation is likely right; the first (most
// trusted) alternates rank above the long tail when the run is capped.
const ALIAS_TOP_CONFIDENCE = 0.85;
const ALIAS_RANK_STEP = 0.02;
const ALIAS_MIN_CONFIDENCE = 0.6;
// Two independent websites back a web title, but the model chose them.
export const WEB_TITLE_CONFIDENCE = 0.6;

function hostLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function sourcesOf(candidate: CatalogCandidate): ProposalSourceRef[] {
  if (candidate.evidence && candidate.evidence.length > 0) {
    return candidate.evidence.map((url) => ({ source: candidate.source, ref: url, url, label: hostLabel(url) }));
  }
  return [{ source: candidate.source, ref: candidate.ref, ...(candidate.url ? { url: candidate.url } : {}), label: candidate.title }];
}

function baseDraft(candidate: CatalogCandidate, title: string): Omit<ProposalDraft, 'kind' | 'confidence' | 'domainId' | 'targetRoleId'> {
  return { title, normalizedTitle: normalizeTitle(title), familyId: null, summary: '', sources: sourcesOf(candidate) };
}

function webPlan(candidate: CatalogCandidate, index: CatalogIndex): CandidatePlan {
  if (index.known.has(normalizeTitle(candidate.title))) return { matchedExisting: true, drafts: [] };
  const draft: ProposalDraft = {
    ...baseDraft(candidate, candidate.title.trim()),
    kind: 'new_role',
    domainId: candidate.domainId ?? null,
    targetRoleId: null,
    summary: trimCandidateSummary(candidate.description),
    confidence: WEB_TITLE_CONFIDENCE,
  };
  return { matchedExisting: false, drafts: [draft] };
}

/**
 * Drafts for one occupation: aliases when it matches a catalog role, or one
 * unclassified new role when it does not (unless only aliases are wanted, as
 * for the ESCO lookups of titles the catalog already has).
 */
export function draftsForCandidate(candidate: CatalogCandidate, index: CatalogIndex, opts: { readonly aliasesOnly?: boolean; readonly aliasCap?: number } = {}): CandidatePlan {
  if (candidate.source === 'web') return webPlan(candidate, index);
  const match = matchOccupation(candidate, index, { aliasCap: opts.aliasCap });
  if (match.kind === 'matched') {
    const target = index.roles.find((role) => role.id === match.roleId);
    const drafts = match.aliasTitles.map((title, rank): ProposalDraft => ({
      ...baseDraft(candidate, title),
      kind: 'new_alias',
      domainId: target?.domainId ?? null,
      targetRoleId: match.roleId,
      confidence: Math.max(ALIAS_MIN_CONFIDENCE, Math.round((ALIAS_TOP_CONFIDENCE - rank * ALIAS_RANK_STEP) * 100) / 100),
    }));
    return { matchedExisting: true, drafts };
  }
  if (opts.aliasesOnly) return { matchedExisting: false, drafts: [] };
  const draft: ProposalDraft = {
    ...baseDraft(candidate, candidate.title.trim()),
    kind: 'new_role',
    domainId: null,
    targetRoleId: null,
    summary: trimCandidateSummary(candidate.description),
    confidence: 0,
  };
  return { matchedExisting: false, drafts: [draft] };
}

export interface AcceptRules {
  /** Every catalog title and alias. */
  readonly known: ReadonlySet<string>;
  /** Titles pending review, rejected in the last 180 days, or proposed earlier in this run. */
  readonly blocked: ReadonlySet<string>;
  readonly minConfidence: number;
}

function acceptable(draft: ProposalDraft, rules: AcceptRules): boolean {
  if (!draft.normalizedTitle || catalogTitleProblem(draft.title)) return false;
  if (rules.known.has(draft.normalizedTitle) || rules.blocked.has(draft.normalizedTitle)) return false;
  if (draft.kind === 'new_alias') return draft.targetRoleId !== null;
  // Without a confident domain a new role is noise for a hiring catalog
  // ("Farmworkers" in a tech-heavy catalog), so it never reaches the queue.
  return draft.domainId !== null && draft.confidence >= rules.minConfidence;
}

export function acceptDrafts(drafts: readonly ProposalDraft[], rules: AcceptRules): { readonly accepted: ProposalDraft[]; readonly skipped: number } {
  const seen = new Set<string>();
  const accepted: ProposalDraft[] = [];
  for (const draft of drafts) {
    if (seen.has(draft.normalizedTitle) || !acceptable(draft, rules)) continue;
    seen.add(draft.normalizedTitle);
    accepted.push(draft);
  }
  return { accepted, skipped: drafts.length - accepted.length };
}

export interface CappableProposal {
  readonly id: string;
  readonly kind: string;
  readonly confidence: number;
  readonly createdAt: Date;
}

/** Aliases first, then the most confident, then the oldest. */
function capRank(a: CappableProposal, b: CappableProposal): number {
  if (a.kind !== b.kind) return a.kind === 'new_alias' ? -1 : 1;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/** Ids beyond the cap, which the run removes so the queue holds its best `max`. */
export function capOverflow(rows: readonly CappableProposal[], max: number): string[] {
  return [...rows].sort(capRank).slice(max).map((row) => row.id);
}
