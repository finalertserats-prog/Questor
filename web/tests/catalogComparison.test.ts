import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  competencyKeyLabel,
  isComparisonEmpty,
  omittedBeyondCore,
  sharedSummary,
  type CatalogComparison,
} from '../src/components/scorecard/catalogComparisonModel';
import { CatalogComparisonPanel } from '../src/components/scorecard/CatalogComparisonPanel';

/**
 * The comparison exists for one failure: a scorecard approved without the
 * thing it never thought to ask about. So the tests care most about whether
 * an omission is said at all, and whether the panel keeps quiet when it has
 * nothing to compare against.
 */

const COMPARISON: CatalogComparison = {
  roleProfileId: 'data-engineer',
  usual: ['sql & data warehousing', 'etl pipelines', 'data modelling', 'stakeholder communication'],
  shared: ['sql & data warehousing', 'etl pipelines'],
  added: ['kafka streaming'],
  omitted: ['data modelling', 'stakeholder communication'],
  missingCore: ['data modelling'],
};

describe('competencyKeyLabel', () => {
  it('reads a lower-cased key back as a name', () => {
    expect(competencyKeyLabel('stakeholder communication')).toBe('Stakeholder Communication');
  });

  it('keeps an acronym upper rather than capitalising it into a word', () => {
    expect(competencyKeyLabel('sql & data warehousing')).toBe('SQL & Data Warehousing');
  });

  it('leaves a dotted name as it is written', () => {
    expect(competencyKeyLabel('node.js services')).toBe('Node.js Services');
  });

  it('collapses stray whitespace', () => {
    expect(competencyKeyLabel('  etl   pipelines ')).toBe('ETL Pipelines');
  });
});

describe('omittedBeyondCore', () => {
  it('leaves out the core omissions, which are said on their own', () => {
    expect(omittedBeyondCore(COMPARISON)).toEqual(['stakeholder communication']);
  });
});

describe('isComparisonEmpty', () => {
  it('treats a missing comparison as nothing to say', () => {
    expect(isComparisonEmpty(null)).toBe(true);
  });

  it('treats a comparison with no usual set and no differences as nothing to say', () => {
    expect(isComparisonEmpty({ roleProfileId: 'x', usual: [], shared: [], added: [], omitted: [], missingCore: [] })).toBe(true);
  });

  it('has something to say when the catalog knows what the role usually asks for', () => {
    expect(isComparisonEmpty(COMPARISON)).toBe(false);
  });
});

describe('sharedSummary', () => {
  it('counts rather than grades', () => {
    expect(sharedSummary(COMPARISON)).toBe('This scorecard has 2 of the 4 competencies the catalog usually lists for this role.');
  });

  it('says so when the catalog lists nothing usual', () => {
    expect(sharedSummary({ ...COMPARISON, usual: [], shared: [] }))
      .toBe('The catalog does not list a usual set of competencies for this role.');
  });
});

describe('CatalogComparisonPanel', () => {
  const html = (comparison: CatalogComparison | null) =>
    renderToStaticMarkup(createElement(CatalogComparisonPanel, { comparison }));

  it('draws nothing at all when there is no comparison', () => {
    expect(html(null)).toBe('');
  });

  it('draws nothing when the catalog has no version of this role', () => {
    expect(html({ roleProfileId: 'x', usual: [], shared: [], added: [], omitted: [], missingCore: [] })).toBe('');
  });

  it('names what is core to the role and missing from this scorecard', () => {
    const markup = html(COMPARISON);

    expect(markup).toContain('Core to this role, and not on this scorecard');
    expect(markup).toContain('Data Modelling');
  });

  it('separates the merely usual omissions from the core ones', () => {
    const markup = html(COMPARISON);

    expect(markup).toContain('Usually asked for, and not here');
    expect(markup).toContain('Stakeholder Communication');
  });

  it('shows what this advert adds', () => {
    expect(html(COMPARISON)).toContain('Kafka Streaming');
  });

  it('leaves the missing-core block out when nothing core is missing', () => {
    expect(html({ ...COMPARISON, omitted: [], missingCore: [] })).not.toContain('Core to this role');
  });
});
