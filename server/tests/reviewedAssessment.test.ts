import { describe, it, expect } from 'vitest';
import type { AssessmentResult, CompetencyScore } from '../src/domain/types.js';
import {
  applyReviewOverrides, assessmentDifferences, reviewedOutcome, type CompletedReview,
} from '../src/domain/reviewedAssessment.js';

/**
 * What a completed human review does to an assessment: it is the version the
 * team acts on, and the difference between it and the AI's own output is the
 * record the AI is meant to learn from.
 */

function competency(id: string, name: string, level: number | null): CompetencyScore {
  return {
    id, name, level, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: level === null,
    evidence: [{ turnId: id, startMs: 0, endMs: 1, quote: `Something about ${name}.` }],
    rationale: '', rubricVersion: 'r',
  };
}

const AI: AssessmentResult = {
  assessmentVersion: 'A-1', roleScorecardVersion: 's', recommendation: 'PROCEED', confidence: 0.8,
  evidenceCoverage: 0.7, overallScore: 78,
  competencies: [competency('sql', 'SQL', 4), competency('stake', 'Stakeholder management', 2), competency('lead', 'Leadership', null)],
  strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
};

function review(over: Partial<CompletedReview> = {}): CompletedReview {
  return {
    id: 'r1', reviewerId: 'u1', disposition: 'CONSIDER', reason: 'Wanted more depth on stakeholders.',
    comments: '', completedAt: new Date('2026-09-20T10:00:00.000Z'),
    overrides: [{ competencyId: 'stake', from: 2, to: 4, reason: 'They described this better than the transcript suggests.' }],
    ...over,
  };
}

describe('the reviewed assessment', () => {
  it('takes the level the reviewer recorded', () => {
    const reviewed = applyReviewOverrides(AI, review());
    expect(reviewed.competencies.find((c) => c.id === 'stake')?.level).toBe(4);
  });

  it('leaves the competencies the reviewer did not touch alone', () => {
    const reviewed = applyReviewOverrides(AI, review());
    expect(reviewed.competencies.find((c) => c.id === 'sql')?.level).toBe(4);
  });

  it('counts a competency the reviewer graded as evidenced, whatever the AI said', () => {
    const reviewed = applyReviewOverrides(AI, review({ overrides: [{ competencyId: 'lead', from: null, to: 3, reason: 'Covered in the second half.' }] }));
    expect(reviewed.competencies.find((c) => c.id === 'lead')).toMatchObject({ level: 3, notEnoughEvidence: false });
  });

  it("takes the reviewer's disposition as the recommendation", () => {
    expect(applyReviewOverrides(AI, review()).recommendation).toBe('CONSIDER');
  });

  it('drops the AI overall score rather than recomputing one nobody gave', () => {
    expect(applyReviewOverrides(AI, review()).overallScore).toBeNull();
  });

  it('is the AI assessment itself when no review has been completed', () => {
    expect(applyReviewOverrides(AI, null)).toBe(AI);
  });

  it('ignores an override that names a competency the assessment does not have', () => {
    const reviewed = applyReviewOverrides(AI, review({ overrides: [{ competencyId: 'ghost', from: 1, to: 5, reason: '' }] }));
    expect(reviewed.competencies).toHaveLength(3);
  });

  it('ignores an override whose new level is not a level', () => {
    const reviewed = applyReviewOverrides(AI, review({ overrides: [{ competencyId: 'sql', from: 4, to: 'much better', reason: '' }] }));
    expect(reviewed.competencies.find((c) => c.id === 'sql')?.level).toBe(4);
  });

  it('ignores a disposition it does not recognise', () => {
    expect(applyReviewOverrides(AI, review({ disposition: 'MAYBE' })).recommendation).toBe('PROCEED');
  });
});

describe('the outcome the team acts on', () => {
  it('is the human verdict once a review is completed', () => {
    expect(reviewedOutcome(AI, review())).toEqual({ source: 'human', recommendation: 'CONSIDER', reviewedAt: review().completedAt });
  });

  it("is the AI's until then", () => {
    expect(reviewedOutcome(AI, null)).toEqual({ source: 'ai', recommendation: 'PROCEED', reviewedAt: null });
  });
});

describe('the differences, for the AI to learn from', () => {
  const diff = assessmentDifferences(AI, review());

  it('lists what the reviewer changed, with both values', () => {
    expect(diff.competencies.filter((c) => c.changed)).toEqual([
      {
        competencyId: 'stake', competencyName: 'Stakeholder management', aiLevel: 2, humanLevel: 4,
        changed: true, reason: 'They described this better than the transcript suggests.',
      },
    ]);
  });

  it('keeps the competencies the reviewer agreed with, so agreement is visible too', () => {
    expect(diff.competencies.filter((c) => !c.changed).map((c) => c.competencyId)).toEqual(['sql', 'lead']);
  });

  it('compares the two verdicts', () => {
    expect(diff.disposition).toEqual({ ai: 'PROCEED', human: 'CONSIDER', agreed: false });
  });

  it('carries the reviewer’s own words about the interview', () => {
    expect(assessmentDifferences(AI, review({ comments: 'Stronger in person than on paper.' })).comments)
      .toBe('Stronger in person than on paper.');
  });

  it('sums up the agreement in one line', () => {
    expect(diff.summary).toBe('The reviewer changed 1 of 3 competency levels and did not agree with the AI recommendation.');
  });

  it('says so plainly when the reviewer agreed throughout', () => {
    const agreed = assessmentDifferences(AI, review({ disposition: 'PROCEED', overrides: [] }));
    expect(agreed.summary).toBe('The reviewer changed no competency levels and agreed with the AI recommendation.');
  });

  it('has nothing to compare before a review exists', () => {
    expect(assessmentDifferences(AI, null)).toBeNull();
  });
});
