import { describe, it, expect } from 'vitest';
import { OBSERVER_QUOTE_SYSTEM_PROMPT, validateEvidenceQuotes, type QuoteSegment } from '../src/services/observerQuotes.js';

/**
 * The AI observer quotes; it never judges.
 *
 * Whatever the model sends back is treated as untrusted. Only verbatim
 * excerpts of the captured transcript, filed under a competency the role's
 * scorecard actually has, survive. Scores, ratings, recommendations and
 * summaries are dropped in code, so a model that ignores its instructions
 * cannot put a judgement in front of a recruiter.
 */

const COMPETENCIES = [
  { id: 'ownership', name: 'Ownership' },
  { id: 'sql', name: 'SQL' },
];

const segments: QuoteSegment[] = [
  { index: 0, kind: 'SPEECH', offsetMs: 0, text: 'Tell me about a time you owned an incident.' },
  { index: 1, kind: 'SPEECH', offsetMs: 30_000, text: 'I led the rollback of our billing pipeline   and wrote the postmortem myself.' },
  { index: 2, kind: 'GAP', offsetMs: 60_000, text: '' },
  { index: 3, kind: 'SPEECH', offsetMs: 90_000, text: 'We partitioned the table by month to keep the joins fast.' },
];

const validate = (raw: unknown) => validateEvidenceQuotes(raw, segments, COMPETENCIES);

describe('keeping verbatim evidence', () => {
  it('keeps a verbatim quote under a scorecard competency', () => {
    const result = validate({ quotes: [{ competencyId: 'ownership', quote: 'I led the rollback of our billing pipeline' }] });

    expect(result.quotes).toHaveLength(1);
  });

  it('stamps a kept quote with the time of the segment it came from, not a time the model supplied', () => {
    const result = validate({ quotes: [{ competencyId: 'sql', quote: 'partitioned the table by month', offsetMs: 5 }] });

    expect(result.quotes[0]).toEqual({
      competencyId: 'sql', competencyName: 'SQL', quote: 'partitioned the table by month', segmentIndex: 3, offsetMs: 90_000,
    });
  });

  it('treats runs of whitespace as equal but nothing else', () => {
    const result = validate({ quotes: [{ competencyId: 'ownership', quote: 'billing pipeline and wrote the postmortem' }] });

    expect(result.quotes).toHaveLength(1);
  });

  it('keeps each distinct quote once', () => {
    const quote = { competencyId: 'ownership', quote: 'wrote the postmortem myself' };
    const result = validate({ quotes: [quote, quote] });

    expect(result.quotes).toHaveLength(1);
  });
});

describe('refusing what is not verbatim', () => {
  it('drops a paraphrase', () => {
    const result = validate({ quotes: [{ competencyId: 'ownership', quote: 'I personally led the billing rollback' }] });

    expect(result.quotes).toHaveLength(0);
  });

  it('counts a paraphrase as not verbatim', () => {
    const result = validate({ quotes: [{ competencyId: 'ownership', quote: 'The candidate clearly owned the incident' }] });

    expect(result.dropped.notVerbatim).toBe(1);
  });

  it('drops a quote that changes the case of the words', () => {
    const result = validate({ quotes: [{ competencyId: 'sql', quote: 'We Partitioned The Table by month' }] });

    expect(result.quotes).toHaveLength(0);
  });

  it('drops a quote stitched across two segments', () => {
    const result = validate({ quotes: [{ competencyId: 'ownership', quote: 'owned an incident. I led the rollback' }] });

    expect(result.quotes).toHaveLength(0);
  });

  it('drops a fragment too short to be evidence', () => {
    const result = validate({ quotes: [{ competencyId: 'sql', quote: 'the' }] });

    expect(result.quotes).toHaveLength(0);
  });

  it('drops a quote filed under a competency the scorecard does not have', () => {
    const result = validate({ quotes: [{ competencyId: 'leadership', quote: 'I led the rollback of our billing pipeline' }] });

    expect(result.dropped.unknownCompetency).toBe(1);
  });
});

describe('refusing judgement', () => {
  it('drops a quote that carries a score', () => {
    const result = validate({ quotes: [{ competencyId: 'ownership', quote: 'I led the rollback of our billing pipeline', score: 4 }] });

    expect(result.quotes).toHaveLength(0);
  });

  it('drops a quote that carries a rating or recommendation', () => {
    const result = validate({ quotes: [
      { competencyId: 'ownership', quote: 'wrote the postmortem myself', rating: 'strong' },
      { competencyId: 'sql', quote: 'partitioned the table by month', recommendation: 'hire' },
    ] });

    expect(result.dropped.evaluative).toBe(2);
  });

  it('never passes a judgement through in the kept quotes', () => {
    const result = validate({
      recommendation: 'Strong hire',
      overallScore: 87,
      summary: 'A confident, senior engineer.',
      quotes: [{ competencyId: 'sql', quote: 'partitioned the table by month', reason: 'shows deep SQL expertise' }],
    });

    expect(JSON.stringify(result.quotes)).not.toMatch(/hire|87|confident|expertise/i);
  });

  it('reports the top-level judgements it stripped', () => {
    const result = validate({ recommendation: 'Strong hire', overallScore: 87, summary: 'Senior.', quotes: [] });

    expect(result.dropped.evaluative).toBe(3);
  });

  it('keeps no field on a quote beyond the evidence itself', () => {
    const result = validate({ quotes: [{ competencyId: 'sql', quote: 'partitioned the table by month', note: 'good' }] });

    expect(Object.keys(result.quotes[0]).sort()).toEqual(['competencyId', 'competencyName', 'offsetMs', 'quote', 'segmentIndex']);
  });
});

describe('malformed model output', () => {
  it('returns no quotes for a reply that is not an object', () => {
    expect(validate('Strong hire, 9/10').quotes).toEqual([]);
  });

  it('returns no quotes when the list is missing', () => {
    expect(validate({ verdict: 'hire' }).quotes).toEqual([]);
  });

  it('skips entries that are not quote objects', () => {
    const result = validate({ quotes: ['I led the rollback', 42, null] });

    expect(result.dropped.malformed).toBe(3);
  });
});

describe('the instruction the model is given', () => {
  it('forbids scores, ratings and recommendations', () => {
    expect(OBSERVER_QUOTE_SYSTEM_PROMPT).toMatch(/never.*score/i);
  });

  it('demands exact excerpts of the transcript', () => {
    expect(OBSERVER_QUOTE_SYSTEM_PROMPT).toMatch(/verbatim/i);
  });
});
