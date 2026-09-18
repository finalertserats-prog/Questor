import { describe, expect, it } from 'vitest';
import { bandDisplay, canCreateRoleFromCatalog, newRoleLabel, parseTechStackInput, shouldOfferNewRole } from '../src/components/catalogModel';

describe('catalogModel', () => {
  it('formats experience bands without duplicate parenthetical years', () => {
    expect(bandDisplay('Senior / Lead (8–12 yrs)', 8, 12)).toBe('Senior · 8–12 yrs');
    expect(bandDisplay('Executive / Distinguished (18+ yrs)', 18, null)).toBe('Executive · 18+ yrs');
  });

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

  it('requires domain, band, region, source readiness and either catalog role or custom title to create', () => {
    const base = { domainId: 'domain', experienceBand: 'senior', regionCode: 'IN', source: 'paste' as const, sourceReady: true, catalogRoleId: 'role', title: '' };
    expect(canCreateRoleFromCatalog(base)).toBe(true);
    expect(canCreateRoleFromCatalog({ ...base, catalogRoleId: undefined, title: 'Custom Role' })).toBe(true);
    expect(canCreateRoleFromCatalog({ ...base, domainId: '' })).toBe(false);
    expect(canCreateRoleFromCatalog({ ...base, experienceBand: undefined })).toBe(false);
    expect(canCreateRoleFromCatalog({ ...base, regionCode: '' })).toBe(false);
    expect(canCreateRoleFromCatalog({ ...base, sourceReady: false })).toBe(false);
    expect(canCreateRoleFromCatalog({ ...base, catalogRoleId: undefined, title: '  ' })).toBe(false);
  });
});
