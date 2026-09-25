import { describe, expect, it } from 'vitest';
import { canCreateRoleFromCatalog, catalogLinkFields, isCurrentQuery, jurisdictionAfterRegionChange, jurisdictionHint, jurisdictionsForRegion, newRoleLabel, parseTechStackInput, shouldOfferNewRole, type JurisdictionOption } from '../src/components/catalogModel';

describe('catalogModel', () => {
  it('offers new role creation only for useful non-exact queries', () => {
    expect(shouldOfferNewRole('AI', { exact: false })).toBe(true);
    expect(shouldOfferNewRole(' A ', { exact: false })).toBe(false);
    expect(shouldOfferNewRole('Forward Deployed Engineer', { exact: true })).toBe(false);
  });

  it('builds a trimmed new-role label in the chosen domain', () => {
    expect(newRoleLabel('  Quantum Risk Wrangler  ', 'Security')).toBe('Add "Quantum Risk Wrangler" as a new role in Security');
  });

  it('parses tech stack input as comma/newline-separated, deduped, bounded tags', () => {
    const parsed = parseTechStackInput(['React'], ' TypeScript, react\nPostgres, ,This value is deliberately longer than forty characters');
    expect(parsed).toEqual(['React', 'TypeScript', 'Postgres']);
  });

  it('caps tech stack tags at fifteen including existing values', () => {
    const existing = Array.from({ length: 14 }, (_, i) => `Tag${i}`);
    expect(parseTechStackInput(existing, 'One, Two')).toEqual([...existing, 'One']);
  });

  it('requires domain, band, region and source readiness; a catalog role or typed title is optional', () => {
    const base = { domainId: 'domain', experienceBand: 'senior', regionCode: 'IN', source: 'paste' as const, sourceReady: true, catalogRoleId: 'role', title: '' };
    expect(canCreateRoleFromCatalog(base)).toBe(true);
    expect(canCreateRoleFromCatalog({ ...base, catalogRoleId: undefined, title: 'Custom Role' })).toBe(true);
    expect(canCreateRoleFromCatalog({ ...base, domainId: '' })).toBe(false);
    expect(canCreateRoleFromCatalog({ ...base, experienceBand: undefined })).toBe(false);
    expect(canCreateRoleFromCatalog({ ...base, regionCode: '' })).toBe(false);
    expect(canCreateRoleFromCatalog({ ...base, sourceReady: false })).toBe(false);

  });

  it('allows a blank title so the JD or requisition can supply it, as before the catalog', () => {
    expect(canCreateRoleFromCatalog({ title: '  ', source: 'paste', sourceReady: true, domainId: 'd1', experienceBand: 'senior', regionCode: 'IN' })).toBe(true);
  });

  it('sends the domain so the server can link a typed or inferred title, and not when a catalog role is chosen', () => {
    expect(catalogLinkFields({ catalogRoleId: '', domainId: 'd1' })).toEqual({ domainId: 'd1' });
    expect(catalogLinkFields({ catalogRoleId: 'c1', domainId: 'd1' })).toEqual({ catalogRoleId: 'c1' });
  });

  it('applies a typeahead response only if the query and domain it was for are still current', () => {
    expect(isCurrentQuery({ domainId: 'd1', value: 'eng' }, { domainId: 'd1', value: 'eng' })).toBe(true);
    expect(isCurrentQuery({ domainId: 'd1', value: 'eng' }, { domainId: 'd1', value: '' })).toBe(false);
    expect(isCurrentQuery({ domainId: 'd1', value: 'eng' }, { domainId: 'd2', value: 'eng' })).toBe(false);
  });
});

/**
 * The state or city field on the role form. Offered only where naming a place
 * changes what a candidate must be told; leaving it unset keeps the role under
 * its region, exactly as every role behaved before the field existed.
 */
describe('choosing a state or city', () => {
  const OPTIONS: readonly JurisdictionOption[] = [
    { code: 'US-IL', regionCode: 'NA', name: 'United States — Illinois', why: 'Illinois has its own rules about AI in interviews.' },
    { code: 'US-NY-NYC', regionCode: 'NA', name: 'United States — New York City', why: 'New York City requires notice before the tool is used.' },
  ];

  it('offers the places inside the chosen region', () => {
    expect(jurisdictionsForRegion(OPTIONS, 'NA').map((j) => j.code)).toEqual(['US-IL', 'US-NY-NYC']);
  });

  it('offers nothing for a region with no finer places', () => {
    expect(jurisdictionsForRegion(OPTIONS, 'EU')).toEqual([]);
  });

  it('offers nothing before a region is chosen', () => {
    expect(jurisdictionsForRegion(OPTIONS, '')).toEqual([]);
  });

  it('says why a chosen place is offered', () => {
    expect(jurisdictionHint(OPTIONS, 'US-IL')).toMatch(/Illinois/);
  });

  it('says plainly what leaving it unset means', () => {
    expect(jurisdictionHint(OPTIONS, '')).toMatch(/Leave this unset/);
  });

  it('drops a state left over from another region rather than submitting it', () => {
    expect(jurisdictionAfterRegionChange(jurisdictionsForRegion(OPTIONS, 'EU'), 'US-IL')).toBe('');
  });

  it('keeps a state that the newly chosen region still offers', () => {
    expect(jurisdictionAfterRegionChange(jurisdictionsForRegion(OPTIONS, 'NA'), 'US-IL')).toBe('US-IL');
  });
});
