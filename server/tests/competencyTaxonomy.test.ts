import { describe, it, expect } from 'vitest';
import {
  CANONICAL_COMPETENCIES,
  baselineCompetencies,
  canonicalByKey,
  competenciesForDomain,
  extractableCompetencies,
  resolveCanonical,
} from '../src/domain/taxonomy/index.js';
import {
  CANONICAL_ROLE_PROFILES,
  canonicalRoleProfileFor,
  compareToCanonicalRole,
  domainTagFor,
} from '../src/domain/taxonomy/catalogMap.js';
import { competencyKeyOf } from '../src/domain/calibration.js';
import { ROLE_CATALOG } from '../src/seed/catalog/roleCatalog.js';

/**
 * The vocabulary has to be internally consistent or the guarantees built on it
 * are worthless: a role profile naming a competency that does not exist would
 * silently report it missing from every advert for ever.
 */

describe('the canonical vocabulary', () => {
  it('gives every competency a key derived from its own name', () => {
    for (const c of CANONICAL_COMPETENCIES) {
      expect(c.key).toBe(competencyKeyOf(c.name));
    }
  });

  it('has no two competencies under one key', () => {
    const keys = CANONICAL_COMPETENCIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never lets one alias point at two different competencies', () => {
    const seen = new Map<string, string>();
    for (const c of CANONICAL_COMPETENCIES) {
      for (const alias of c.aliases) {
        const key = competencyKeyOf(alias);
        const already = seen.get(key);
        // An alias colliding with a canonical name is resolved in favour of the
        // canonical one, which is fine; two competencies claiming the same
        // alias is not.
        if (already && already !== c.key && !canonicalByKey(key)) {
          throw new Error(`alias "${alias}" claimed by both ${already} and ${c.key}`);
        }
        seen.set(key, c.key);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('gives every competency a definition, indicators and at least one cue', () => {
    for (const c of CANONICAL_COMPETENCIES) {
      expect(c.definition.length, c.name).toBeGreaterThan(20);
      expect(c.indicators.length, c.name).toBeGreaterThanOrEqual(3);
      expect(c.cues.length, c.name).toBeGreaterThanOrEqual(1);
    }
  });

  it('resolves a near-duplicate spelling onto the canonical entry', () => {
    expect(resolveCanonical('Data Warehousing / SQL')?.name).toBe('SQL & Data Warehousing');
    expect(resolveCanonical('  sql  ')?.name).toBe('SQL & Data Warehousing');
    expect(resolveCanonical('Product Ownership')?.name).toBe('Product Management');
    expect(resolveCanonical('K8s cluster wrangling')).toBeNull();
  });

  it('keeps the four platform baseline competencies, named as they always were', () => {
    const names = baselineCompetencies().map((c) => c.name);
    expect(names).toEqual(['Communication', 'Problem Solving', 'Collaboration', 'Ownership & Impact']);
  });

  it('never counts a baseline competency as extractable', () => {
    for (const c of extractableCompetencies()) expect(c.baseline).not.toBe(true);
  });

  it('covers every catalog domain with at least a few competencies of its own', () => {
    for (const domain of ROLE_CATALOG.domains) {
      const tag = domainTagFor(domain.name);
      expect(tag, `no tag for catalog domain "${domain.name}"`).not.toBeNull();
      const own = competenciesForDomain(tag!).filter((c) => c.domains.length > 0);
      expect(own.length, `${domain.name} has no domain-specific competencies`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the bare word "product" is not a Product Management requirement', () => {
  const product = canonicalByKey('product management')!;
  const fires = (line: string) => product.cues.some((re) => re.test(line));

  it('does not fire on a collaboration mention', () => {
    expect(fires('Partner with product teams to deliver trustworthy data.')).toBe(false);
    expect(fires('Collaborate with analysts, product and engineering.')).toBe(false);
    expect(fires('Work with the product organisation on data contracts.')).toBe(false);
  });

  it('fires on a real product requirement', () => {
    expect(fires('Own the product roadmap for the payments area.')).toBe(true);
    expect(fires('Run product discovery with customers.')).toBe(true);
    expect(fires('Write PRDs and acceptance criteria.')).toBe(true);
  });
});

describe('canonical role profiles', () => {
  it('only name competencies that exist', () => {
    for (const profile of CANONICAL_ROLE_PROFILES) {
      for (const key of [...profile.usual, ...profile.core]) {
        expect(canonicalByKey(key), `${profile.id} names unknown competency "${key}"`).not.toBeNull();
      }
    }
  });

  it('keeps every core competency inside the usual set', () => {
    for (const profile of CANONICAL_ROLE_PROFILES) {
      for (const key of profile.core) {
        expect(profile.usual, `${profile.id}: core "${key}" is not usual`).toContain(key);
      }
    }
  });

  it('has no two profiles under one id', () => {
    const ids = CANONICAL_ROLE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('recognises a role shape from its title', () => {
    expect(canonicalRoleProfileFor('Senior Data Engineer', 'data')?.id).toBe('data_engineer');
    expect(canonicalRoleProfileFor('Group Product Manager', 'product')?.id).toBe('product_manager');
    expect(canonicalRoleProfileFor('Chief Happiness Beetle', null)).toBeNull();
  });
});

describe('compareToCanonicalRole', () => {
  it('shows what the JD adds and what it leaves out', () => {
    const comparison = compareToCanonicalRole(
      'Senior Data Engineer',
      'data',
      ['sql & data warehousing', 'data engineering & pipelines', 'security engineering', 'communication'],
    )!;
    expect(comparison.roleProfileId).toBe('data_engineer');
    expect(comparison.shared).toContain('sql & data warehousing');
    expect(comparison.added).toContain('security engineering');
    expect(comparison.omitted).toContain('data modeling');
    expect(comparison.missingCore).toEqual([]);
  });

  it('calls out a missing core competency', () => {
    const comparison = compareToCanonicalRole('Senior Data Engineer', 'data', ['communication'])!;
    expect(comparison.missingCore).toContain('sql & data warehousing');
    expect(comparison.missingCore).toContain('data engineering & pipelines');
  });

  it('does not report the platform baseline as an unusual addition', () => {
    const comparison = compareToCanonicalRole('Senior Data Engineer', 'data', ['communication', 'collaboration'])!;
    expect(comparison.added).not.toContain('communication');
    expect(comparison.added).not.toContain('collaboration');
  });

  it('says nothing at all about a role shape it does not recognise', () => {
    expect(compareToCanonicalRole('Chief Happiness Beetle', null, ['communication'])).toBeNull();
  });
});
