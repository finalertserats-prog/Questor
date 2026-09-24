import { describe, expect, it } from 'vitest';
import {
  BASELINE_NOTE,
  NO_SPAN_NOTE,
  TECH_STACK_NOTE,
  provenanceOf,
  sectionLabel,
  sourceCitation,
} from '../src/components/scorecard/competencySourceModel';

/**
 * A competency is what every candidate for the role gets measured against, so
 * the rule these tests hold is one rule: it shows the advert's own words, or
 * it says it has none. Never a third thing, and never an empty quotation
 * dressed up as evidence.
 */

describe('sectionLabel', () => {
  it('names the job description section a reader would recognise', () => {
    expect(sectionLabel('nice_to_have')).toBe('Nice to have');
  });

  it('calls an unplaced line the job description rather than "Unknown"', () => {
    expect(sectionLabel('unknown')).toBe('Job description');
  });

  it('falls back to the job description when no section came with the line', () => {
    expect(sectionLabel(undefined)).toBe('Job description');
  });

  it('shows a section key it does not know rather than hiding the line', () => {
    expect(sectionLabel('about_the_team')).toBe('About the team');
  });
});

describe('sourceCitation', () => {
  it('cites the section and the line number', () => {
    expect(sourceCitation({ section: 'requirements', line: 18 })).toBe('Requirements, line 18');
  });

  it('cites the section alone when the line number is not usable', () => {
    expect(sourceCitation({ section: 'requirements', line: 0 })).toBe('Requirements');
  });
});

describe('provenanceOf', () => {
  it('quotes the job description line and cites where it came from', () => {
    const read = provenanceOf({ source: { text: '5+ years of SQL and data warehousing.', line: 18, section: 'requirements' } });

    expect(read).toMatchObject({ kind: 'span', quote: '5+ years of SQL and data warehousing.', citation: 'Requirements, line 18' });
  });

  it('falls back to the plain sourceText an older record kept, with no line invented', () => {
    const read = provenanceOf({ sourceText: 'Experience building ETL pipelines.' });

    expect(read).toMatchObject({ kind: 'span', quote: 'Experience building ETL pipelines.', citation: 'Job description' });
  });

  it('prefers the span over the plain text when it has both', () => {
    const read = provenanceOf({
      source: { text: 'Owns the reporting layer.', line: 4, section: 'responsibilities' },
      sourceText: 'something older',
    });

    expect(read).toMatchObject({ kind: 'span', quote: 'Owns the reporting layer.' });
  });

  it('says a baseline competency was not taken from this advert', () => {
    expect(provenanceOf({ origin: 'baseline' })).toMatchObject({ kind: 'stated', note: BASELINE_NOTE });
  });

  it('says a tech stack competency came from the stack, not the advert', () => {
    expect(provenanceOf({ origin: 'tech_stack' })).toMatchObject({ kind: 'stated', note: TECH_STACK_NOTE });
  });

  it('admits when nothing at all was recorded', () => {
    expect(provenanceOf({})).toMatchObject({ kind: 'none', note: NO_SPAN_NOTE });
  });

  it('treats a blank span as no span rather than quoting emptiness', () => {
    const read = provenanceOf({ source: { text: '   ', line: 3, section: 'requirements' }, sourceText: '' });

    expect(read.kind).toBe('none');
  });

  it('marks a low-confidence reading as uncertain', () => {
    const read = provenanceOf({ source: { text: 'Some exposure to Kafka would help.', line: 30, section: 'nice_to_have' }, lowConfidence: true });

    expect(read.uncertain).toBe(true);
  });

  it('leaves a competency with no confidence field unmarked', () => {
    expect(provenanceOf({ sourceText: 'Owns the roadmap.' }).uncertain).toBe(false);
  });

  it('carries the rationale through so the page can show it', () => {
    const read = provenanceOf({ origin: 'baseline', rationale: 'Asked on every role by the platform.' });

    expect(read.rationale).toBe('Asked on every role by the platform.');
  });

  it('reports no rationale rather than an empty one', () => {
    expect(provenanceOf({ rationale: '  ' }).rationale).toBeNull();
  });
});
