// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { AssessmentPart, ReviewOrderingLine } from '../src/components/assessment/AssessmentPart';
import { DifferencesSection } from '../src/components/assessment/DifferencesSection';
import { RecordedReview } from '../src/components/assessment/RecordedReview';
import { SkillsGrid, type SkillView } from '../src/components/assessment/SkillsGrid';

/**
 * The three parts of the assessment page: what the AI found, what the
 * reviewer decided, and where they differ — plus the two things that make the
 * record mean anything, which are when each was written and which came first.
 */

afterEach(cleanup);

const DIFFERENCES = {
  competencies: [
    { competencyId: 'c1', competencyName: 'System design', aiLevel: 4, humanLevel: 4, changed: false, reason: '' },
    { competencyId: 'c2', competencyName: 'Reliability', aiLevel: 2, humanLevel: 4, changed: true, reason: 'He gave the whole diagnosis at 18:40.' },
  ],
  disposition: { ai: 'CONSIDER', human: 'PROCEED', agreed: false },
  reason: 'Worth the next round.',
  comments: '',
  summary: 'The reviewer changed 1 of 2 competency levels and did not agree with the AI recommendation.',
  reviewedAt: '2026-09-23T04:11:00.000Z',
};

const SKILLS: SkillView[] = [
  {
    id: 'c2',
    name: 'Distributed systems & reliability',
    level: 2,
    requiredLevel: 3,
    notEnoughEvidence: false,
    rationale: 'Named backoff but did not explain the failure mode it prevents.',
    evidence: [{ turnId: 't9', startMs: 1_120_000, quote: 'Jittered exponential backoff on the client.' }],
  },
];

describe('a part of the page', () => {
  it('is numbered, named, and says when it was recorded', () => {
    render(h(AssessmentPart, { number: 1, id: 'p1', title: 'What the AI found', when: 'recorded 22 Sep 2026' },
      h('p', null, 'body')));
    const part = screen.getByTestId('assessment-part-1');
    expect(part.textContent).toContain('Part 1');
    expect(part.textContent).toContain('What the AI found');
    expect(screen.getByTestId('part-1-when').textContent).toBe('recorded 22 Sep 2026');
  });
});

describe('which reading came first', () => {
  it('says the reviewer judged before the AI was visible, and what that means', () => {
    render(h(ReviewOrderingLine, {
      ordering: { kind: 'blind_first', label: 'Recorded before the AI\'s reading was visible', detail: 'The reviewer judged from the transcript.' },
    }));
    expect(screen.getByTestId('review-ordering').textContent).toContain('before');
  });

  it('says nothing at all where an older server sent nothing, rather than guessing', () => {
    const { container } = render(h(ReviewOrderingLine, { ordering: null }));
    expect(container.textContent).toBe('');
  });
});

describe('where the two readings differ', () => {
  it('shows both values side by side', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES }));
    const table = screen.getByTestId('differences-table');
    expect(table.textContent).toContain('2/5');
    expect(table.textContent).toContain('4/5');
  });

  it('shows the reviewer\'s own reason for the change', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES }));
    expect(screen.getByTestId('differences-table').textContent).toContain('18:40');
  });

  it('never characterises the disagreement', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES }));
    const text = screen.getByTestId('differences-table').textContent ?? '';
    expect(text).not.toContain('graded higher');
    expect(text).not.toContain('graded lower');
  });

  it('says in so many words that it is not commenting on the human', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES }));
    expect(screen.getByTestId('differences-neutral').textContent).toContain('does not comment');
  });

  it('states both verdicts in the one vocabulary', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES }));
    const overall = screen.getByTestId('differences-overall').textContent ?? '';
    expect(overall).toContain('Consider');
    expect(overall).toContain('Proceed');
  });

  it('says what the record is used for, and does not claim models learn from candidates', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES }));
    const learning = screen.getByTestId('learning-note').textContent ?? '';
    expect(learning).toContain('agreement statistics');
    expect(learning).toContain('No model is trained or fine-tuned on candidate data');
  });

  it('says what will appear here before anyone has reviewed', () => {
    render(h(DifferencesSection, { differences: null }));
    expect(screen.getByTestId('differences-empty')).toBeTruthy();
  });
});

describe('a calibrated level, when the calibration lane has published one', () => {
  it('is absent from the table until it is there', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES }));
    expect(screen.getByTestId('differences-table').textContent).not.toContain('Calibrated');
  });

  it('appears as its own column, with where it came from', () => {
    render(h(DifferencesSection, {
      differences: DIFFERENCES,
      calibration: { competencies: [{ competencyId: 'c2', level: 3, provenance: 'from 42 reviews on this role' }] },
    }));
    const table = screen.getByTestId('differences-table');
    expect(table.textContent).toContain('Calibrated');
    expect(table.textContent).toContain('from 42 reviews on this role');
  });

  it('ignores a payload it cannot read rather than breaking the comparison', () => {
    render(h(DifferencesSection, { differences: DIFFERENCES, calibration: { competencies: 'not a list' } }));
    expect(screen.getByTestId('differences-table').textContent).not.toContain('Calibrated');
  });
});

describe('the recorded review', () => {
  const props = {
    verdict: 'PROCEED',
    reason: 'He gave the whole diagnosis at 18:40.',
    comments: '',
    completedAt: '2026-09-23T04:11:00.000Z',
    reviewerName: 'Rahul Verma',
    ordering: { kind: 'blind_first' as const, label: 'Recorded before the AI\'s reading was visible', detail: 'x' },
    overrides: [{ competencyId: 'c2', name: 'Reliability', from: 2, to: 4 }],
    competencyCount: 5,
  };

  it('keeps the reviewer\'s own words, not just their answer', () => {
    render(h(RecordedReview, props));
    expect(screen.getByTestId('recorded-reason').textContent).toContain('18:40');
  });

  it('names the verdict in the one vocabulary', () => {
    render(h(RecordedReview, props));
    expect(screen.getByTestId('recorded-verdict').textContent).toContain('Proceed');
  });

  it('lists the levels they changed', () => {
    render(h(RecordedReview, props));
    expect(screen.getByTestId('recorded-overrides').textContent).toContain('Reliability');
  });

  it('says plainly when they changed nothing, which is itself a judgement', () => {
    render(h(RecordedReview, { ...props, overrides: [] }));
    expect(screen.getByTestId('recorded-overrides').textContent).toContain('agreement');
  });

  it('carries the ordering with it', () => {
    render(h(RecordedReview, props));
    expect(screen.getByTestId('review-ordering')).toBeTruthy();
  });
});

describe('the competencies while a blind reviewer is deciding', () => {
  const masked: SkillView[] = [{ ...SKILLS[0], level: null, rationale: '' }];

  it('shows the competency and what the role asks for', () => {
    render(h(SkillsGrid, { skills: masked, activeChip: '', onChip: () => undefined, masked: true }));
    const grid = screen.getByTestId('skills-grid');
    expect(grid.textContent).toContain('Distributed systems & reliability');
    expect(grid.textContent).toContain('Needs 3/5');
  });

  it('shows the evidence quotes, which are what the candidate said and not the AI\'s opinion', () => {
    render(h(SkillsGrid, { skills: masked, activeChip: '', onChip: () => undefined, masked: true }));
    expect(screen.getAllByTestId('evidence-chip')).toHaveLength(1);
  });

  it('keeps the chips pressable, so a quote still marks its turn in the transcript', () => {
    const seen: string[] = [];
    render(h(SkillsGrid, { skills: masked, activeChip: '', onChip: (c) => seen.push(c.turnId), masked: true }));
    screen.getAllByTestId('evidence-chip')[0].click();
    expect(seen).toEqual(['t9']);
  });

  it('withholds the AI\'s own level, and says so rather than looking broken', () => {
    render(h(SkillsGrid, { skills: masked, activeChip: '', onChip: () => undefined, masked: true }));
    expect(screen.getByTestId('skill-withheld').textContent).toContain('withheld');
    expect(screen.getByTestId('skills-masked-note').textContent).toContain('withheld until you record your own');
  });

  it('withholds the AI\'s reasoning too', () => {
    render(h(SkillsGrid, { skills: SKILLS, activeChip: '', onChip: () => undefined, masked: true }));
    expect(screen.getByTestId('skills-grid').textContent).not.toContain('Named backoff');
  });

  it('shows everything once the reviewer has recorded their own verdict', () => {
    render(h(SkillsGrid, { skills: SKILLS, activeChip: '', onChip: () => undefined }));
    const grid = screen.getByTestId('skills-grid');
    expect(grid.textContent).toContain('2/5');
    expect(grid.textContent).toContain('Named backoff');
  });
});
