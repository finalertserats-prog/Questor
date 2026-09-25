import { normalizeTitle } from './catalogText.js';

/**
 * Pure matching of outside occupations (O*NET, ESCO, web research) against the
 * shared catalog. Nothing here touches the database, so the rules that decide
 * what reaches the owner's review queue are pinned by plain unit tests.
 */

export type CatalogSourceName = 'onet' | 'esco' | 'web';

export interface CatalogCandidate {
  readonly title: string;
  readonly description?: string;
  /** Ordered by preference: the source puts its most trusted titles first. */
  readonly alternateTitles: readonly string[];
  readonly ref: string;
  readonly url?: string;
  readonly source: CatalogSourceName;
  /** Set by web research, which asks about one domain at a time. */
  readonly domainId?: string;
  /** Every link supporting a web-research title, shown to the owner. */
  readonly evidence?: readonly string[];
}

export interface CatalogRoleForMatch {
  readonly id: string;
  readonly title: string;
  readonly domainId: string;
  readonly familyId: string | null;
  readonly aliases: readonly string[];
}

export interface CatalogIndex {
  /** Normalised title or alias → every active role carrying it. */
  readonly byTitle: ReadonlyMap<string, readonly CatalogRoleForMatch[]>;
  /** Every normalised title and alias, whatever the domain. */
  readonly known: ReadonlySet<string>;
  readonly roles: readonly CatalogRoleForMatch[];
}

export type OccupationMatch =
  | { readonly kind: 'matched'; readonly roleId: string | null; readonly aliasTitles: readonly string[]; readonly ambiguous: boolean }
  | { readonly kind: 'unmatched' };

export const DEFAULT_ALIAS_CAP = 10;

export function buildCatalogIndex(roles: readonly CatalogRoleForMatch[]): CatalogIndex {
  const byTitle = new Map<string, CatalogRoleForMatch[]>();
  const add = (key: string, role: CatalogRoleForMatch) => {
    if (!key) return;
    const current = byTitle.get(key) ?? [];
    if (!current.some((existing) => existing.id === role.id)) byTitle.set(key, [...current, role]);
  };
  for (const role of roles) {
    add(normalizeTitle(role.title), role);
    for (const alias of role.aliases) add(normalizeTitle(alias), role);
  }
  return { byTitle, known: new Set(byTitle.keys()), roles };
}

function distinctRoles(lists: readonly (readonly CatalogRoleForMatch[])[]): CatalogRoleForMatch[] {
  const seen = new Map<string, CatalogRoleForMatch>();
  for (const list of lists) for (const role of list) if (!seen.has(role.id)) seen.set(role.id, role);
  return [...seen.values()];
}

/**
 * The role an occupation belongs to, or null when that is ambiguous. The
 * occupation's own title wins over its alternates: "Data Scientists" whose
 * alternates include "Software Engineer" is still about data science. When
 * only alternates match and they point at different roles, guessing would put
 * a wrong alias on a shared role for every organisation, so nothing is offered.
 */
function targetRole(titleHits: readonly CatalogRoleForMatch[], alternateHits: readonly CatalogRoleForMatch[]): CatalogRoleForMatch | null {
  if (titleHits.length > 0) return titleHits.length === 1 ? titleHits[0] : null;
  return alternateHits.length === 1 ? alternateHits[0] : null;
}

function unknownTitles(titles: readonly string[], index: CatalogIndex, cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of titles) {
    const title = raw.replace(/\s+/g, ' ').trim();
    const key = normalizeTitle(title);
    if (!key || seen.has(key) || index.known.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Matched when the occupation's title or any alternate equals a catalog title
 * or alias. A matched occupation offers its unknown titles as aliases of its
 * role (its own title first, then alternates in the source's order).
 */
export function matchOccupation(candidate: CatalogCandidate, index: CatalogIndex, opts: { readonly aliasCap?: number } = {}): OccupationMatch {
  const titleHits = index.byTitle.get(normalizeTitle(candidate.title)) ?? [];
  const alternateHits = distinctRoles(candidate.alternateTitles.map((alt) => index.byTitle.get(normalizeTitle(alt)) ?? []));
  if (titleHits.length === 0 && alternateHits.length === 0) return { kind: 'unmatched' };
  const target = targetRole(titleHits, alternateHits);
  if (!target) return { kind: 'matched', roleId: null, aliasTitles: [], ambiguous: true };
  const aliasTitles = unknownTitles([candidate.title, ...candidate.alternateTitles], index, opts.aliasCap ?? DEFAULT_ALIAS_CAP);
  return { kind: 'matched', roleId: target.id, aliasTitles, ambiguous: false };
}

const SUMMARY_MAX_CHARS = 400;
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|approx|incl)\.$/i;

/**
 * A new role's summary is shown to candidates, so it is the source's own
 * description cut to two sentences, never an internal note.
 */
export function trimCandidateSummary(description: string | undefined): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentences: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    current = current ? `${current} ${word}` : word;
    if (/[.!?]$/.test(word) && !ABBREVIATIONS.test(word)) {
      sentences.push(current);
      current = '';
      if (sentences.length === 2) break;
    }
  }
  const summary = sentences.length > 0 ? sentences.join(' ') : current;
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : summary;
}
