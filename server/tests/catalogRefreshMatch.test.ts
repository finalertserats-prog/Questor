import { describe, expect, it } from 'vitest';
import { buildCatalogIndex, matchOccupation, trimCandidateSummary, type CatalogCandidate, type CatalogRoleForMatch } from '../src/domain/catalogMatch.js';

function role(id: string, title: string, domainId: string, aliases: readonly string[] = []): CatalogRoleForMatch {
  return { id, title, domainId, familyId: null, aliases };
}

function occupation(title: string, alternateTitles: readonly string[] = []): CatalogCandidate {
  return { title, alternateTitles, ref: '15-1252.00', source: 'onet' };
}

const index = buildCatalogIndex([
  role('swe', 'Software Engineer', 'tech', ['Developer']),
  role('ds', 'Data Scientist', 'data'),
  // The same title in two domains: allowed by the catalog, ambiguous to an import.
  role('pm-tech', 'Product Manager', 'tech'),
  role('pm-bank', 'Product Manager', 'bank'),
]);

describe('matching an occupation to the catalog', () => {
  it('matches an occupation whose title equals a catalog title', () => {
    expect(matchOccupation(occupation('Software Engineer'), index)).toMatchObject({ kind: 'matched', roleId: 'swe' });
  });

  it('matches an occupation whose title equals a catalog alias, ignoring case and punctuation', () => {
    expect(matchOccupation(occupation('developer!'), index)).toMatchObject({ kind: 'matched', roleId: 'swe' });
  });

  it('proposes nothing for an occupation that only repeats known titles', () => {
    expect(matchOccupation(occupation('Software Engineer', ['Developer']), index)).toMatchObject({ aliasTitles: [] });
  });

  it('matches an occupation through one of its alternate titles', () => {
    expect(matchOccupation(occupation('Software Developers', ['Software Engineer']), index)).toMatchObject({ kind: 'matched', roleId: 'swe' });
  });

  it('offers the occupation title as an alias when it matched through an alternate', () => {
    expect(matchOccupation(occupation('Software Developers', ['Software Engineer']), index)).toMatchObject({ aliasTitles: ['Software Developers'] });
  });

  it('offers unknown alternates of a matched occupation as aliases, in source order', () => {
    const match = matchOccupation(occupation('Software Engineer', ['Application Developer', 'Developer', 'Coder']), index);
    expect(match).toMatchObject({ aliasTitles: ['Application Developer', 'Coder'] });
  });

  it('offers each alias once even when the source repeats it', () => {
    const match = matchOccupation(occupation('Software Engineer', ['Coder', 'coder', 'CODER.']), index);
    expect(match).toMatchObject({ aliasTitles: ['Coder'] });
  });

  it('caps the aliases offered for one occupation', () => {
    const alternates = Array.from({ length: 15 }, (_, i) => `Coder Grade ${String.fromCharCode(65 + i)}`);
    const match = matchOccupation(occupation('Software Engineer', alternates), index, { aliasCap: 10 });
    expect(match.kind === 'matched' ? match.aliasTitles.length : -1).toBe(10);
  });

  it('reports an occupation that matches nothing as unmatched', () => {
    expect(matchOccupation(occupation('Farmworkers', ['Crop Picker']), index)).toEqual({ kind: 'unmatched' });
  });

  it('prefers the occupation-title match when alternates point at another domain', () => {
    const match = matchOccupation(occupation('Data Scientist', ['Software Engineer', 'Quant Researcher']), index);
    expect(match).toMatchObject({ kind: 'matched', roleId: 'ds', aliasTitles: ['Quant Researcher'] });
  });

  it('skips aliases when alternates point at roles in different domains and the title matches none', () => {
    const match = matchOccupation(occupation('Analysts', ['Software Engineer', 'Data Scientist', 'Numbers Person']), index);
    expect(match).toEqual({ kind: 'matched', roleId: null, aliasTitles: [], ambiguous: true });
  });

  it('skips aliases when the occupation title itself exists in two domains', () => {
    const match = matchOccupation(occupation('Product Manager', ['Product Owner']), index);
    expect(match).toEqual({ kind: 'matched', roleId: null, aliasTitles: [], ambiguous: true });
  });

  it('leaves out alternates that normalise to nothing', () => {
    const match = matchOccupation(occupation('Software Engineer', ['---', ' ']), index);
    expect(match).toMatchObject({ aliasTitles: [] });
  });
});

describe('catalog index', () => {
  it('knows every title and alias in normalised form', () => {
    expect([...buildCatalogIndex([role('a', 'C# Developer', 'tech', ['.NET Dev'])]).known].sort()).toEqual(['c# developer', 'net dev']);
  });
});

describe('summary for a proposed role', () => {
  it('keeps the first two sentences', () => {
    expect(trimCandidateSummary('First sentence. Second sentence! Third sentence?')).toBe('First sentence. Second sentence!');
  });

  it('does not split on an abbreviation', () => {
    expect(trimCandidateSummary('Plan tools, e.g. lathes. Maintain them. Order parts.')).toBe('Plan tools, e.g. lathes. Maintain them.');
  });

  it('collapses whitespace and line breaks', () => {
    expect(trimCandidateSummary('  Build\n\nthings.  ')).toBe('Build things.');
  });

  it('returns an empty summary when there is no description', () => {
    expect(trimCandidateSummary(undefined)).toBe('');
  });

  it('bounds a description with no sentence ending', () => {
    expect(trimCandidateSummary('word '.repeat(300)).length).toBeLessThanOrEqual(400);
  });
});
