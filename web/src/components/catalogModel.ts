import { GLOBAL_REGION_CODE } from './roleLabelModel';

export interface CatalogResultState { readonly exact: boolean }

export function shouldOfferNewRole(query: string, results: CatalogResultState): boolean {
  return query.trim().length >= 2 && !results.exact;
}

export function newRoleLabel(query: string, domainName: string): string {
  return `Add "${query.trim()}" as a new role in ${domainName}`;
}

export function parseTechStackInput(existing: readonly string[], raw: string): readonly string[] {
  const seen = new Set(existing.map((v) => v.toLowerCase()));
  const next = [...existing];
  for (const part of raw.split(/[,\n]/)) {
    const value = part.trim();
    if (!value || value.length > 40) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(value);
    if (next.length >= 15) break;
  }
  return next;
}

/** What choosing a region means, shown under the Region field; only Global needs saying. */
export function regionHint(regionCode: string): string {
  return regionCode === GLOBAL_REGION_CODE
    ? 'Open in every region. The job description names no country, currency or visa rules, and the role shows under every region in the roles list.'
    : '';
}

/** A finer place inside a region, as GET /api/catalog/jurisdictions returns it. */
export interface JurisdictionOption {
  readonly code: string;
  readonly regionCode: string;
  readonly name: string;
  readonly why: string;
}

/**
 * The finer places offered for a region. Empty for every region we have done
 * no analysis of, and the field is not shown at all in that case — an empty
 * dropdown says "we have nothing for you here" less clearly than no dropdown.
 */
export function jurisdictionsForRegion(all: readonly JurisdictionOption[], regionCode: string): readonly JurisdictionOption[] {
  const region = regionCode.trim().toUpperCase();
  return region ? all.filter((j) => j.regionCode === region) : [];
}

/**
 * What choosing a state or city means. Naming one says why it is offered;
 * leaving it unset says plainly that the role is treated as the region, which
 * is what happens and what someone hurrying past the field should know.
 */
export function jurisdictionHint(options: readonly JurisdictionOption[], code: string): string {
  const chosen = options.find((j) => j.code === code);
  if (chosen) return chosen.why;
  return 'Leave this unset unless the role is in one of these places. '
    + 'Setting it adds the notices that place asks a candidate to be given before an AI interview.';
}

/**
 * The state or city to submit once a region is chosen. A value left over from
 * another region belongs to no place the new region offers, and submitting it
 * is refused by the server — so it is dropped here instead.
 */
export function jurisdictionAfterRegionChange(options: readonly JurisdictionOption[], code: string): string {
  return options.some((j) => j.code === code) ? code : '';
}

export interface RoleCreateReadiness {
  readonly domainId: string;
  readonly experienceBand?: string;
  readonly regionCode: string;
  readonly source: 'paste' | 'ats';
  readonly sourceReady: boolean;
}

/**
 * What still stands between the form and a create, in the words shown beside
 * the disabled button. The title is not among them: left blank, the JD or the
 * requisition supplies it, as it did before the catalog.
 */
export function missingRoleFields(opts: RoleCreateReadiness): string[] {
  return [
    opts.domainId ? null : 'a domain',
    opts.experienceBand ? null : 'an experience band',
    opts.regionCode ? null : 'a region',
    opts.sourceReady ? null : opts.source === 'ats' ? 'a valid ATS requisition id' : 'the job description',
  ].filter((item): item is string => item !== null);
}

export function canCreateRoleFromCatalog(opts: RoleCreateReadiness): boolean {
  return missingRoleFields(opts).length === 0;
}

/**
 * The catalog part of a create request. A chosen catalog role is sent as is;
 * otherwise the domain goes, so the server finds or adds the final title
 * (typed or inferred) in the shared catalog instead of leaving it unlinked.
 */
export function catalogLinkFields(opts: { readonly catalogRoleId: string; readonly domainId: string }): { catalogRoleId: string } | { domainId: string } {
  return opts.catalogRoleId ? { catalogRoleId: opts.catalogRoleId } : { domainId: opts.domainId };
}

export interface TypeaheadQuery {
  readonly domainId: string;
  readonly value: string;
}

/** A typeahead response is shown only if the input and domain are still what it was asked for. */
export function isCurrentQuery(askedFor: TypeaheadQuery, now: TypeaheadQuery): boolean {
  return askedFor.domainId === now.domainId && askedFor.value === now.value;
}


/** The active option index kept inside [0, count - 1]; 0 when there are no options. */
export function clampActiveOption(active: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(active, 0), count - 1);
}

/**
 * Whether to ask about adding the title to the shared catalog: only for a
 * typed title that is not a chosen catalog role. The server no longer adds a
 * title to the catalog every organisation sees unless asked to.
 */
export function shouldOfferCatalogAdd(opts: { readonly title: string; readonly catalogRoleId: string }): boolean {
  return Boolean(opts.title.trim()) && !opts.catalogRoleId;
}
