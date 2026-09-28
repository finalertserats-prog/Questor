// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { FitVsInterview } from '../src/components/fit/FitVsInterview';
import { compareFitWithInterview, comparisonHeadline, type Fit, type InterviewCompetency } from '../src/components/fit/fitModel';

/**
 * Putting the CV next to the interview is the claim the product is making, so
 * the tests are about whether the comparison is both precise and kind: joined
 * on id, quoting both sides, and never describing a candidate whose CV said
 * more than one conversation showed as having been caught out.
 */

afterEach(cleanup);

const cvRead = (id: string, name: string, strength: 'evidenced' | 'partial' | 'not_evidenced', quote = '') => ({
  competencyId: id, name, classification: 'essential', mustHave: false, strength,
  score: strength === 'not_evidenced' ? null : 80,
  evidence: quote ? [{ line: 3, quote, section: 'experience' }] : [],
  explanation: '',
});

const FIT: Fit = {
  overall: 70, confidence: 0.7, components: [], missing: [], probes: [],
  competencies: [
    cvRead('c1', 'Pipeline Engineering', 'evidenced', 'Owned the Kafka ingestion.'),
    cvRead('c2', 'Dimensional Modelling', 'evidenced', 'Designed the star schema.'),
    cvRead('c3', 'Stakeholder Communication', 'not_evidenced'),
    cvRead('c4', 'Mentoring', 'not_evidenced'),
    cvRead('c5', 'Cost Optimisation', 'evidenced', 'Cut warehouse spend by a third.'),
  ],
};

const graded = (id: string, level: number | null, notEnoughEvidence = false, quote = ''): InterviewCompetency => ({
  id, name: id, level, requiredLevel: 3, notEnoughEvidence,
  evidence: quote ? [{ turnId: `t-${id}`, quote }] : [],
});

const INTERVIEW: InterviewCompetency[] = [
  graded('c1', 4, false, 'I rebuilt the consumer so a replay could not double-write.'),
  graded('c2', 2, false, 'I mostly follow whatever schema is already there.'),
  graded('c3', 4, false, 'I ran the monthly review with the commercial team myself.'),
  graded('c4', null, true),
  // c5 was never covered.
];

describe('joining the two readings', () => {
  const rows = compareFitWithInterview(FIT, INTERVIEW);

  it('joins on competency id, never on name', () => {
    const renamed = INTERVIEW.map((c) => ({ ...c, name: 'something else entirely' }));
    expect(compareFitWithInterview(FIT, renamed).map((r) => r.kind)).toEqual(rows.map((r) => r.kind));
  });

  it('puts the disagreements first', () => {
    expect(rows[0].kind).toBe('interview_found_less');
  });

  it('marks a competency the CV claimed and the interview graded below the bar', () => {
    expect(rows.find((r) => r.competencyId === 'c2')!.kind).toBe('interview_found_less');
  });

  it('marks a competency the CV never mentioned and the interview evidenced', () => {
    expect(rows.find((r) => r.competencyId === 'c3')!.kind).toBe('interview_went_further');
  });

  it('marks agreement where both point the same way', () => {
    expect(rows.find((r) => r.competencyId === 'c1')!.kind).toBe('agreed');
  });

  it('says neither has evidence rather than calling it a failure', () => {
    const row = rows.find((r) => r.competencyId === 'c4')!;
    expect(row.kind).toBe('neither');
    expect(row.sentence).toContain('open question rather than a negative');
  });

  it('says plainly when the interview did not cover something', () => {
    expect(rows.find((r) => r.competencyId === 'c5')!.kind).toBe('not_assessed');
  });

  it('is empty when there is no line-by-line CV reading', () => {
    expect(compareFitWithInterview({ ...FIT, competencies: [] }, INTERVIEW)).toEqual([]);
  });
});

describe('the wording where the two disagree', () => {
  const rows = compareFitWithInterview(FIT, INTERVIEW);

  it('describes a shortfall as a conversation that did not reach it', () => {
    const row = rows.find((r) => r.competencyId === 'c2')!;
    expect(row.sentence).toContain('One conversation is a small sample');
  });

  it('never accuses the candidate of anything', () => {
    const said = rows.map((r) => r.sentence).join(' ').toLowerCase();
    for (const word of ['lied', 'lying', 'exaggerat', 'overstat', 'false', 'dishonest', 'inflated']) {
      expect(said, `the comparison said "${word}"`).not.toContain(word);
    }
  });

  it('credits the interview for finding what paper missed', () => {
    expect(rows.find((r) => r.competencyId === 'c3')!.sentence).toContain('a screen on paper alone would have missed');
  });

  it('counts both directions in one headline', () => {
    expect(comparisonHeadline(rows)).toContain('did not come through');
    expect(comparisonHeadline(rows)).toContain('never mentioned');
  });

  it('says so when the two agree everywhere', () => {
    const agreeing = compareFitWithInterview({ ...FIT, competencies: [cvRead('c1', 'Pipeline Engineering', 'evidenced', 'x')] }, [graded('c1', 4)]);
    expect(comparisonHeadline(agreeing)).toBe('The CV and the interview point the same way on every competency.');
  });
});

describe('the panel', () => {
  const panel = (over: Partial<Parameters<typeof FitVsInterview>[0]> = {}) =>
    render(h(FitVsInterview, { fit: FIT, interview: INTERVIEW, ...over } as never));

  it('shows both sides with their own quotes', () => {
    panel();
    const row = screen.getByTestId('fvi-row-c1');
    expect(row.textContent).toContain('Owned the Kafka ingestion.');
    expect(row.textContent).toContain('I rebuilt the consumer so a replay could not double-write.');
  });

  it('names what each pairing is, in words', () => {
    panel();
    expect(screen.getByTestId('fvi-kind-c2').textContent).toBe('CV said more than the interview showed');
    expect(screen.getByTestId('fvi-kind-c3').textContent).toBe('Interview showed more than the CV said');
  });

  it('says the level reached against the level required', () => {
    panel();
    expect(screen.getByTestId('fvi-row-c2').textContent).toContain('level 2 of a required 3');
  });

  it('warns the reader before they conclude anything', () => {
    panel();
    expect(screen.getByTestId('fvi-headline').textContent).toContain('Read the quotes on both sides');
  });

  it('defers to the blind-review gate in the gate\'s own words', () => {
    const { container } = panel({ blockedReason: 'Record your own verdict first.' });
    expect(container.textContent).toContain('Record your own verdict first.');
    expect(screen.queryByTestId('fit-vs-interview')).toBeNull();
  });

  it('says there is nothing to compare rather than showing an empty grid', () => {
    const { container } = panel({ fit: { ...FIT, competencies: [] } });
    expect(container.textContent).toContain('no line-by-line CV reading');
  });
});
