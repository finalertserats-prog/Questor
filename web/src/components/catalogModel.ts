export type BandId = 'emerging' | 'developing' | 'established' | 'senior' | 'principal' | 'executive';

export interface CatalogResultState { readonly exact: boolean }

export function bandDisplay(label: string, minYears: number, maxYears: number | null): string {
  const clean = label.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\/.*$/, '').trim();
  return `${clean} · ${maxYears === null ? `${minYears}+` : `${minYears}–${maxYears}`} yrs`;
}

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

export function canCreateRoleFromCatalog(opts: { readonly catalogRoleId?: string; readonly title: string; readonly source: 'paste' | 'ats'; readonly sourceReady: boolean; readonly domainId: string; readonly experienceBand?: string; readonly regionCode: string }): boolean {
  return Boolean(opts.domainId && opts.experienceBand && opts.regionCode && opts.sourceReady && (opts.catalogRoleId || opts.title.trim()));
}

