import { describe, expect, it } from 'vitest';
import type { AssessmentResult, CompetencyScore } from '../src/domain/types.js';
import { HEAD_NOT_COVERED, buildFeedbackDraft } from '../src/services/candidateFeedbackDraft.js';
import { MARKER_LABEL, buildEvidenceFeedback, coverageMarker } from '../src/services/feedbackContentModel.js';

// "These did not come up, so there is nothing here about them either way."
//
// Written to a candidate after a ten-answer interview about exactly the three
// things listed under it, and the same assessment's own evidence table quotes
// their answers under each of those three headings. Both judges reached it
// independently, on four separate transcripts, without being pointed at it —
// it was the most-named "worst problem" in the whole report.
//
// The cause was two buckets where the conversation has three. `isEvidenced`
// requires `!gradingUnavailable`, so a competency that was asked about,
// answered, and has the candidate's own words attached — but that the grader
// could not score — landed in `notCovered`, and `notCovered` is printed under
// "did not come up". Whether we could GRADE something and whether it CAME UP
// are different questions, and only one of them is the candidate's business.

function score(over: Partial<CompetencyScore> & { id: string; name: string }): CompetencyScore {
  return {
    id: over.id,
    name: over.name,
    level: null,
    requiredLevel: 3,
    weight: 0.33,
    confidence: 0.5,
    rationale: '',
    evidence: [],
    notEnoughEvidence: false,
    ...over,
  } as CompetencyScore;
}

const QUOTE = { turnId: 't4', quote: 'I rebuilt the loader so the nightly job reconciles against the source counts.', startMs: 0, endMs: 1 };

function assessment(competencies: CompetencyScore[]): AssessmentResult {
  return {
    overallScore: null,
    recommendation: 'CONSIDER',
    competencies,
    strengths: [],
    concerns: [],
    contradictions: [],
    limitations: [],
    summary: '',
  } as unknown as AssessmentResult;
}

const NAMES = { candidateName: 'Priya Raman', roleTitle: 'Data Engineer' };

describe('the letter never says a topic did not come up when it did', () => {
  it('keeps a competency that was asked about but could not be graded out of "not covered"', () => {
    const draft = buildFeedbackDraft({
      ...NAMES,
      assessment: assessment([
        score({ id: 'c_sql', name: 'SQL & Data Warehousing', gradingUnavailable: true, evidence: [QUOTE] }),
      ]),
    });
    expect(draft.notCovered).toEqual([]);
    expect(draft.text).not.toContain('SQL & Data Warehousing');
    expect(draft.text).not.toContain(HEAD_NOT_COVERED);
  });

  it('says nothing at all about it, rather than inventing a reason', () => {
    // If we cannot say anything honest about a competency, silence is the only
    // honest option left: every alternative is a sentence about our own
    // machinery, dressed up as a finding about the person.
    const draft = buildFeedbackDraft({
      ...NAMES,
      assessment: assessment([
        score({ id: 'c_sql', name: 'SQL & Data Warehousing', level: 4, gradingUnavailable: true, evidence: [QUOTE] }),
        score({ id: 'c_pipe', name: 'Data Engineering & Pipelines', level: 4, evidence: [QUOTE] }),
      ]),
    });
    expect(draft.strengths).toEqual(['Data Engineering & Pipelines']);
    expect(draft.develop).toEqual([]);
    expect(draft.notCovered).toEqual([]);
    expect(draft.text).not.toContain('SQL & Data Warehousing');
  });

  it('still says "not covered" about a competency that genuinely did not come up', () => {
    const draft = buildFeedbackDraft({
      ...NAMES,
      assessment: assessment([
        score({ id: 'c_pipe', name: 'Data Engineering & Pipelines', level: 4, evidence: [QUOTE] }),
        score({ id: 'c_cloud', name: 'Cloud & Platform Architecture', notEnoughEvidence: true, evidence: [] }),
      ]),
    });
    expect(draft.notCovered).toEqual(['Cloud & Platform Architecture']);
    expect(draft.text).toContain(HEAD_NOT_COVERED);
  });

  it('is the exact letter from the report, and no longer says the untrue thing', () => {
    // Every competency asked about; the grader unavailable on all of them —
    // which is what every completed run in the report produced.
    const draft = buildFeedbackDraft({
      ...NAMES,
      assessment: assessment([
        score({ id: 'c_sql', name: 'SQL & Data Warehousing', gradingUnavailable: true, evidence: [QUOTE] }),
        score({ id: 'c_pipe', name: 'Data Engineering & Pipelines', gradingUnavailable: true, evidence: [QUOTE] }),
        score({ id: 'c_cloud', name: 'Cloud & Platform Architecture', gradingUnavailable: true, evidence: [QUOTE] }),
      ]),
    });
    expect(draft.hasContent).toBe(false);
    // It may still say there was not enough to give useful feedback — that is
    // true. What it may not do is name the three topics as not having come up.
    expect(draft.text).not.toMatch(/did not come up/);
    expect(draft.text).not.toContain('SQL & Data Warehousing');
    expect(draft.notCovered).toEqual([]);
  });

  it('keeps the "not enough to say" letter honest when nothing came up at all', () => {
    const draft = buildFeedbackDraft({
      ...NAMES,
      assessment: assessment([
        score({ id: 'c_sql', name: 'SQL & Data Warehousing', notEnoughEvidence: true, evidence: [] }),
      ]),
    });
    expect(draft.notCovered).toEqual(['SQL & Data Warehousing']);
    expect(draft.text).toMatch(/did not come up/);
  });
});

describe('the automatic letter draws the same distinction', () => {
  it('marks an ungradeable competency that was discussed "Not scored", never "Not covered"', () => {
    const marker = coverageMarker(score({ id: 'a', name: 'A', level: 1, gradingUnavailable: true, evidence: [QUOTE] }));
    expect(marker).toBe('unscored');
    expect(MARKER_LABEL[marker]).toBe('Not scored');
  });

  it('still marks a competency with no evidence at all "Not covered"', () => {
    expect(coverageMarker(score({ id: 'a', name: 'A', gradingUnavailable: true, evidence: [] }))).toBe('not-covered');
    expect(coverageMarker(score({ id: 'a', name: 'A', notEnoughEvidence: true, evidence: [] }))).toBe('not-covered');
  });

  it('never tells the candidate an ungradeable topic "did not come up"', () => {
    const content = buildEvidenceFeedback({
      result: assessment([score({ id: 'a', name: 'SQL', level: 4, gradingUnavailable: true, evidence: [QUOTE] })]),
      profile: undefined,
    } as Parameters<typeof buildEvidenceFeedback>[0]);
    const row = content.competencies.find((c) => c.name === 'SQL');
    expect(row?.marker).toBe('unscored');
    expect(row?.whatWeHeard).not.toMatch(/did not come up/);
    expect(row?.whatWeHeard).toMatch(/came up/);
    // Their own words survive: the one part of the letter that is checkable.
    expect(row?.quote).toBeTruthy();
    // And it is never turned into a weakness or a piece of homework.
    const prose = [...content.swot.weaknesses, ...content.nextSteps].join('\n');
    expect(prose).not.toMatch(/SQL did not come up/);
  });
});
