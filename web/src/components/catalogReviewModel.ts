/**
 * Pure logic for the platform owner's catalog review page: filters, labels,
 * source links, bulk selection, inline-edit validation and run summaries.
 * Kept out of the component so every rule is pinned by a node test.
 */

export type ProposalKind = 'new_role' | 'new_alias';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';
export type CatalogSourceName = 'onet' | 'esco' | 'web';

export interface CatalogSourceLink {
  readonly source: CatalogSourceName;
  readonly ref: string;
  readonly url?: string;
  readonly label?: string;
}

export interface NamedRef { readonly id: string; readonly name: string }

export interface CatalogProposalView {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  readonly title: string;
  readonly summary: string;
  readonly confidence: number;
  readonly domain: NamedRef | null;
  readonly family: NamedRef | null;
  readonly targetRole: { readonly id: string; readonly title: string; readonly status: string } | null;
  readonly sources: readonly CatalogSourceLink[];
  readonly reviewerNote: string;
  readonly createdAt: string;
  /** The version shown; sent back on approve so a changed proposal is not approved blind. */
  readonly updatedAt?: string;
}

export interface CatalogReviewFilters {
  readonly status: '' | ProposalStatus;
  readonly kind: '' | ProposalKind;
  readonly domainId: string;
  readonly source: '' | CatalogSourceName;
  readonly q: string;
}

export const DEFAULT_CATALOG_REVIEW_FILTERS: CatalogReviewFilters = { status: 'pending', kind: '', domainId: '', source: '', q: '' };
export const CATALOG_REVIEW_PAGE_SIZE = 25;
/** The server's limit on one bulk request. */
export const BULK_MAX = 100;

export function filtersToQuery(filters: CatalogReviewFilters, page: number, limit: number = CATALOG_REVIEW_PAGE_SIZE): string {
  const params = new URLSearchParams();
  const entries: Array<[string, string]> = [['status', filters.status], ['kind', filters.kind], ['domainId', filters.domainId], ['source', filters.source], ['q', filters.q.trim()]];
  for (const [key, value] of entries) if (value) params.set(key, value);
  params.set('page', String(page));
  params.set('limit', String(limit));
  return params.toString();
}

export function hasActiveFilters(filters: CatalogReviewFilters): boolean {
  return (Object.keys(DEFAULT_CATALOG_REVIEW_FILTERS) as Array<keyof CatalogReviewFilters>)
    .some((key) => filters[key].trim() !== DEFAULT_CATALOG_REVIEW_FILTERS[key]);
}

export function kindLabel(kind: ProposalKind): string {
  return kind === 'new_role' ? 'New role' : 'Alternative title';
}

export function confidenceLabel(value: number): 'High' | 'Medium' | 'Low' {
  if (value >= 0.8) return 'High';
  if (value >= 0.5) return 'Medium';
  return 'Low';
}

export function confidencePercent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

export function placementLabel(proposal: CatalogProposalView): string {
  if (proposal.kind === 'new_alias') return proposal.targetRole ? `Alternative title for ${proposal.targetRole.title}` : 'Role no longer in the catalog';
  if (!proposal.domain) return 'No domain yet';
  return proposal.family ? `${proposal.domain.name} · ${proposal.family.name}` : proposal.domain.name;
}

export interface SourceLinkView {
  readonly key: string;
  readonly text: string;
  readonly href: string | null;
}

function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}

function hostOf(value: string | null): string | null {
  return value ? new URL(value).hostname.replace(/^www\./, '') : null;
}

export function sourceLinks(sources: readonly CatalogSourceLink[]): SourceLinkView[] {
  return sources.map((s, index) => {
    const href = safeHref(s.url);
    const text = s.source === 'onet' ? `O*NET ${s.ref}` : s.source === 'esco' ? 'ESCO' : hostOf(href) ?? s.label ?? 'Web';
    return { key: `${s.source}-${index}-${s.ref}`, text, href };
  });
}

export function toggleSelection(selected: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return selected.has(id) ? new Set([...selected].filter((value) => value !== id)) : new Set([...selected, id]);
}

export function selectablePendingIds(proposals: readonly CatalogProposalView[]): string[] {
  return proposals.filter((p) => p.status === 'pending').map((p) => p.id);
}

export function toggleAll(selected: ReadonlySet<string>, proposals: readonly CatalogProposalView[]): ReadonlySet<string> {
  const ids = selectablePendingIds(proposals);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  return allSelected ? new Set() : new Set(ids);
}

/** After a reload, keep only what is still on screen and still decidable. */
export function pruneSelection(selected: ReadonlySet<string>, proposals: readonly CatalogProposalView[]): ReadonlySet<string> {
  const pending = new Set(selectablePendingIds(proposals));
  return new Set([...selected].filter((id) => pending.has(id)));
}

export interface EditDraft {
  readonly title: string;
  readonly domainId: string;
  readonly familyId: string;
  readonly summary: string;
}

export interface EditOptions {
  readonly domains: readonly (NamedRef & { readonly families: readonly NamedRef[] })[];
}

export function draftFrom(proposal: CatalogProposalView): EditDraft {
  return { title: proposal.title, domainId: proposal.domain?.id ?? '', familyId: proposal.family?.id ?? '', summary: proposal.summary };
}

export function familiesFor(options: EditOptions, domainId: string): readonly NamedRef[] {
  return options.domains.find((d) => d.id === domainId)?.families ?? [];
}

/** The server's catalogTitleProblem, so the owner sees the reason before saving. */
export function titleProblem(title: string): string | null {
  const t = title.trim();
  if (t.length < 2 || t.length > 120) return 'Title must be 2 to 120 characters.';
  if (/[\r\n]/.test(t)) return 'Title must be a single line.';
  if (!/\p{L}/u.test(t)) return 'Title must contain a letter.';
  if (/@|https?:\/\/|www\./i.test(t)) return 'Title must not contain contact details or links.';
  if (/\d{6,}/.test(t)) return 'Title must not contain requisition or phone numbers.';
  return null;
}

export const SUMMARY_MAX = 600;

export function validateEdit(draft: EditDraft, kind: ProposalKind, options: EditOptions): Partial<Record<keyof EditDraft, string>> {
  const title = titleProblem(draft.title);
  const summary = draft.summary.length > SUMMARY_MAX ? 'Keep the summary under 600 characters.' : null;
  const domain = kind === 'new_role' && !draft.domainId ? 'Choose a domain.' : null;
  const family = kind === 'new_role' && draft.familyId && !familiesFor(options, draft.domainId).some((f) => f.id === draft.familyId)
    ? 'Choose a family used in this domain.' : null;
  return {
    ...(title ? { title } : {}),
    ...(domain ? { domainId: domain } : {}),
    ...(family ? { familyId: family } : {}),
    ...(summary ? { summary } : {}),
  };
}

export function editPatch(proposal: CatalogProposalView, draft: EditDraft): Record<string, string | null> {
  const original = draftFrom(proposal);
  const title = draft.title.trim();
  return {
    ...(title !== original.title ? { title } : {}),
    ...(draft.summary !== original.summary ? { summary: draft.summary } : {}),
    ...(proposal.kind === 'new_role' && draft.domainId !== original.domainId ? { domainId: draft.domainId || null } : {}),
    ...(proposal.kind === 'new_role' && draft.familyId !== original.familyId ? { familyId: draft.familyId || null } : {}),
  };
}

export interface DecisionError {
  readonly status?: number;
  readonly code?: string;
  readonly message: string;
}

export function decisionErrorMessage(err: DecisionError, title: string): string {
  if (err.code === 'changed') return `"${title}" changed while you were looking at it. The list now shows the latest version; review it again.`;
  if (err.code === 'too_soon') return err.message;
  if (err.code === 'superseded') return `Not added: ${err.message} The proposal is marked superseded.`;
  if (err.code === 'not_pending') return `"${title}" was already reviewed. The list is up to date.`;
  return `${title}: ${err.message}`;
}

export interface BulkItemResult {
  readonly id: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
}

export function bulkOutcome(results: readonly BulkItemResult[], titles: ReadonlyMap<string, string>, action: 'approve' | 'reject') {
  const done = results.filter((r) => r.ok).length;
  const verb = action === 'approve' ? 'Approved' : 'Rejected';
  const failures = results.filter((r) => !r.ok).map((r) => {
    const title = titles.get(r.id) ?? 'A proposal';
    return r.code === 'superseded' ? `${title}: already in the catalog (superseded).` : `${title}: ${r.error ?? 'could not be decided.'}`;
  });
  return { message: `${verb} ${done} of ${results.length}.`, failures };
}

export interface SourceStatsView {
  readonly fetched: number;
  readonly matchedExisting: number;
  readonly proposed: number;
  readonly skipped: number;
  readonly errors: readonly string[];
  readonly skippedReason?: string;
}

export interface CatalogRunView {
  readonly id: string;
  readonly status: 'running' | 'completed' | 'failed';
  readonly trigger: 'schedule' | 'manual';
  readonly triggeredBy: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly stats: Readonly<Record<CatalogSourceName, SourceStatsView>>;
  readonly llmCalls: number;
  readonly researchCalls: number;
  readonly error: string;
  readonly proposals: number;
}

export function runTotals(run: CatalogRunView) {
  const sources = Object.values(run.stats);
  const sum = (pick: (s: SourceStatsView) => number) => sources.reduce((total, s) => total + pick(s), 0);
  return { fetched: sum((s) => s.fetched), proposed: sum((s) => s.proposed), skipped: sum((s) => s.skipped), errors: sum((s) => s.errors.length) };
}

const SKIP_REASONS: Record<string, string> = { no_openai_key: 'no OpenAI key', demo: 'demo' };

export function runStatusLine(run: CatalogRunView): string {
  const totals = runTotals(run);
  const parts = [
    `${totals.fetched} read`, `${totals.proposed} proposed`, `${totals.skipped} skipped`,
    `${totals.errors} ${totals.errors === 1 ? 'error' : 'errors'}`,
    ...(run.stats.web.skippedReason ? [`web research skipped (${SKIP_REASONS[run.stats.web.skippedReason] ?? run.stats.web.skippedReason})`] : []),
  ];
  const line = parts.join(' · ');
  if (run.status === 'running') return `Running · ${line}`;
  if (run.status === 'failed') return `${runErrorText(run.error)} · ${line}`;
  // A finished run can still carry a code: its operator notice did not go out.
  return run.error ? `${line} · ${runErrorText(run.error)}` : line;
}

const RUN_ERRORS: Record<string, string> = {
  abandoned: 'Stopped and not resumed within 7 days; a fresh run started instead.',
  notice_not_sent: 'No one was emailed about these proposals.',
};

/**
 * The run row keeps a short code; details stay in the server log. Anything
 * unrecognised gets the generic sentence rather than being shown as it came.
 */
export function runErrorText(code: string): string {
  return RUN_ERRORS[code] ?? 'Stopped on an unexpected error; the next run resumes it.';
}

/**
 * Run now stays off while the lease is held AND while the newest run is still
 * marked running: a lapsed lease does not mean that run is over, and the
 * schedule resumes it.
 */
export function runNowDisabled(runs: readonly CatalogRunView[], leaseActive: boolean): boolean {
  return leaseActive || runs[0]?.status === 'running';
}

export interface PageMeta {
  readonly total: number;
  readonly page: number;
  readonly limit: number;
  readonly totalPages: number;
}

export function paginationLabel(meta: PageMeta): string {
  return `Page ${meta.page} of ${meta.totalPages} · ${meta.total} ${meta.total === 1 ? 'proposal' : 'proposals'}`;
}
