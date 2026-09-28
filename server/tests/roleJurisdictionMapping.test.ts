import { describe, expect, it } from 'vitest';
import {
  JURISDICTION_SUBDIVISIONS, jurisdictionFor, jurisdictionForRegion, jurisdictionNotices,
  subdivisionBelongsToRegion, subdivisionByCode, subdivisionsForRegion,
} from '../src/domain/roleJurisdiction.js';

/**
 * A role's jurisdiction used to be its region and nothing more, so Illinois,
 * New York City, Maryland and Colorado — the four places with their own rules
 * about AI in hiring — were all just "NA" and none of their notices could ever
 * be triggered. A role may now carry a finer value. It is optional, and a role
 * without one behaves exactly as it did.
 */

describe('a role with no finer value', () => {
  it('is under its region, as before', () => {
    expect(jurisdictionFor({ regionCode: 'EU' })).toBe('EU');
  });

  it('is under no single jurisdiction when it is Global', () => {
    expect(jurisdictionFor({ regionCode: 'GLOBAL' })).toBe('GLOBAL');
  });

  it('is blank when it has no region', () => {
    expect(jurisdictionFor({})).toBe('');
  });

  it('agrees with the rule it replaced, region for region', () => {
    for (const region of ['GLOBAL', 'NA', 'LATAM', 'UKI', 'EU', 'MENA', 'IN', 'APAC', 'ANZ', '']) {
      expect(jurisdictionFor({ regionCode: region }), region).toBe(jurisdictionForRegion(region));
    }
  });

  it('carries no extra notices', () => {
    expect(jurisdictionNotices('NA')).toEqual([]);
  });
});

describe('a role with a finer value', () => {
  it('is under the finer jurisdiction', () => {
    expect(jurisdictionFor({ regionCode: 'NA', jurisdictionCode: 'US-IL' })).toBe('US-IL');
  });

  it('tells New York City apart from the rest of New York State', () => {
    expect([
      jurisdictionFor({ regionCode: 'NA', jurisdictionCode: 'US-NY-NYC' }),
      jurisdictionFor({ regionCode: 'NA', jurisdictionCode: 'US-NY' }),
    ]).toEqual(['US-NY-NYC', 'US-NY']);
  });

  it('accepts a value typed in lower case', () => {
    expect(jurisdictionFor({ regionCode: 'na', jurisdictionCode: 'us-co' })).toBe('US-CO');
  });

  it('falls back to the region when the finer value belongs to another region', () => {
    expect(jurisdictionFor({ regionCode: 'EU', jurisdictionCode: 'US-IL' })).toBe('EU');
  });

  it('falls back to the region when the finer value is not one we offer', () => {
    expect(jurisdictionFor({ regionCode: 'NA', jurisdictionCode: 'US-ZZ' })).toBe('NA');
  });

  it('falls back to the region when the finer value is blank', () => {
    expect(jurisdictionFor({ regionCode: 'NA', jurisdictionCode: '' })).toBe('NA');
  });
});

describe('the notices a place asks for', () => {
  it('gives New York City its notice period, the qualifications assessed, and the alternative', () => {
    const notices = jurisdictionNotices('US-NY-NYC');
    expect(notices).toHaveLength(3);
    expect(notices.join(' ')).toMatch(/ten business days/);
  });

  it('tells an Illinois candidate that AI is used and that they may ask for deletion', () => {
    expect(jurisdictionNotices('US-IL').join(' ')).toMatch(/deleted/);
  });

  it('tells a Maryland candidate that no facial recognition is used', () => {
    expect(jurisdictionNotices('US-MD').join(' ')).toMatch(/facial recognition/i);
  });

  it('tells a Colorado candidate a high-risk AI system is in use', () => {
    expect(jurisdictionNotices('US-CO').join(' ')).toMatch(/high-risk/i);
  });

  it('adds nothing for New York State outside the city', () => {
    expect(jurisdictionNotices('US-NY')).toEqual([]);
  });

  it('adds nothing for a value it does not know', () => {
    expect(jurisdictionNotices('US-ZZ')).toEqual([]);
  });

  it('never exceeds what a role profile may store', () => {
    for (const s of JURISDICTION_SUBDIVISIONS) {
      expect(s.code.length, s.code).toBeLessThanOrEqual(16);
      for (const notice of s.notices) expect(notice.length, s.code).toBeLessThanOrEqual(500);
    }
  });
});

describe('what a customer may choose from', () => {
  it('offers the four places with their own hiring-AI rules, plus New York State', () => {
    expect(subdivisionsForRegion('NA').map((s) => s.code).sort())
      .toEqual(['US-CO', 'US-IL', 'US-MD', 'US-NY', 'US-NY-NYC']);
  });

  it('offers nothing finer in a region we have not analysed', () => {
    expect(subdivisionsForRegion('APAC')).toEqual([]);
  });

  it('offers nothing finer for a role open in every region', () => {
    expect(subdivisionsForRegion('GLOBAL')).toEqual([]);
  });

  it('names each place so a customer can tell which one they mean', () => {
    expect(subdivisionByCode('US-NY-NYC')?.name).toBe('United States — New York City');
  });

  it('says why each place is offered at all', () => {
    for (const s of JURISDICTION_SUBDIVISIONS) expect(s.why.length, s.code).toBeGreaterThan(20);
  });

  it('accepts a place that belongs to the region and refuses one that does not', () => {
    expect([subdivisionBelongsToRegion('US-IL', 'NA'), subdivisionBelongsToRegion('US-IL', 'EU')]).toEqual([true, false]);
  });

  it('knows nothing of a place it does not offer', () => {
    expect(subdivisionByCode('US-TX')).toBeNull();
  });

  it('gives every place a distinct code', () => {
    const codes = JURISDICTION_SUBDIVISIONS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
