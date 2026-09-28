import { describe, it, expect } from 'vitest';
import {
  DEFAULT_BUSINESS_AREA_LIMIT, MAX_BUSINESS_AREA_LIMIT, ORG_SIZE_IDS, isOrgSize, orgSizeLabel,
  orgNameKey, emailDomainOf, businessAreaSelectionProblem, shouldScopeCatalog,
} from '../src/domain/orgOnboarding.js';

describe('business area limits', () => {
  it('defaults to five areas', () => {
    expect(DEFAULT_BUSINESS_AREA_LIMIT).toBe(5);
  });

  it('never allows more areas than the catalog has domains', () => {
    expect(MAX_BUSINESS_AREA_LIMIT).toBe(35);
  });
});

describe('org size', () => {
  it('accepts a listed size', () => {
    expect(isOrgSize('50-200')).toBe(true);
  });

  it('rejects a size that is not on the list', () => {
    expect(isOrgSize('enormous')).toBe(false);
  });

  it('offers five bands', () => {
    expect(ORG_SIZE_IDS).toHaveLength(5);
  });

  it('labels a size for a reader', () => {
    expect(orgSizeLabel('over-5000')).toBe('More than 5,000 people');
  });
});

describe('orgNameKey', () => {
  it('treats case and punctuation as the same name', () => {
    expect(orgNameKey('Acme Corp.')).toBe(orgNameKey('ACME corp'));
  });

  it('treats a company suffix as noise', () => {
    expect(orgNameKey('Acme Limited')).toBe(orgNameKey('Acme'));
  });

  it('keeps distinct organisations distinct', () => {
    expect(orgNameKey('Acme Health')).not.toBe(orgNameKey('Acme Energy'));
  });

  it('does not collapse a name made only of suffix words onto an empty key', () => {
    expect(orgNameKey('The Group Ltd')).not.toBe('');
  });
});

describe('emailDomainOf', () => {
  it('reads the domain after the last at sign', () => {
    expect(emailDomainOf('Ada@Example.TEST')).toBe('example.test');
  });

  it('answers empty for an address with no domain', () => {
    expect(emailDomainOf('nobody')).toBe('');
  });
});

describe('businessAreaSelectionProblem', () => {
  const known = new Set(['engineering', 'finance', 'sales', 'legal', 'people', 'retail']);

  it('accepts a selection inside the limit', () => {
    expect(businessAreaSelectionProblem(['engineering', 'finance'], known, 5)).toBeNull();
  });

  it('accepts an empty selection', () => {
    expect(businessAreaSelectionProblem([], known, 5)).toBeNull();
  });

  it('refuses more areas than the limit', () => {
    const problem = businessAreaSelectionProblem(['engineering', 'finance', 'sales', 'legal', 'people', 'retail'], known, 5);
    expect(problem?.reason).toBe('too-many');
  });

  it('refuses an area the catalog does not have', () => {
    expect(businessAreaSelectionProblem(['astrology'], known, 5)?.reason).toBe('unknown-area');
  });

  it('refuses the same area twice', () => {
    expect(businessAreaSelectionProblem(['finance', 'finance'], known, 5)?.reason).toBe('duplicate');
  });

  it('names the raised limit in the message when the owner raised it', () => {
    const problem = businessAreaSelectionProblem(['engineering', 'finance', 'sales'], known, 2);
    expect(problem?.message).toContain('up to 2');
  });
});

describe('shouldScopeCatalog', () => {
  it('narrows the catalog for an organisation that chose areas', () => {
    expect(shouldScopeCatalog(['a'], 'mine')).toBe(true);
  });

  it('shows everything to an organisation that chose nothing', () => {
    expect(shouldScopeCatalog([], 'mine')).toBe(false);
  });

  it('shows everything when the organisation asks to see everything', () => {
    expect(shouldScopeCatalog(['a'], 'all')).toBe(false);
  });
});
