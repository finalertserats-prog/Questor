import { describe, it, expect } from 'vitest';
import { clampActiveOption, shouldOfferCatalogAdd } from '../src/components/catalogModel';

describe('clampActiveOption', () => {
  it('is 0 when there are no options', () => {
    expect(clampActiveOption(3, 0)).toBe(0);
  });

  it('never goes past the last option', () => {
    expect(clampActiveOption(5, 3)).toBe(2);
  });

  it('never goes below the first option', () => {
    expect(clampActiveOption(-1, 3)).toBe(0);
  });

  it('keeps an index that is in range', () => {
    expect(clampActiveOption(1, 3)).toBe(1);
  });
});

describe('shouldOfferCatalogAdd', () => {
  it('offers to add a typed title that is not a catalog role', () => {
    expect(shouldOfferCatalogAdd({ title: 'Platform Wrangler', catalogRoleId: '' })).toBe(true);
  });

  it('does not offer when a catalog role was chosen', () => {
    expect(shouldOfferCatalogAdd({ title: 'Backend Engineer', catalogRoleId: 'cr1' })).toBe(false);
  });

  it('does not offer for a blank title', () => {
    expect(shouldOfferCatalogAdd({ title: '  ', catalogRoleId: '' })).toBe(false);
  });
});
