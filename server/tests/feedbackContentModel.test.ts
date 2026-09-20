import { describe, it, expect } from 'vitest';
import type { AssessmentResult, CompetencyScore } from '../src/domain/types.js';
import {
  GENERIC_FEEDBACK, buildEvidenceFeedback, chooseFeedbackContent, feedbackContentSchema,
  feedbackGuardrailViolations, feedbackPromptInput, type FeedbackContent,
} from '../src/services/feedbackContentModel.js';

/**
 * What the candidate's automatic feedback email may say. The rule under test is
 * the owner's: specific and constructive, built from what the candidate said —
 * and never a score, a level, a recommendation or anything that reads as a
 * hiring decision.
 */

function competency(over: Partial<CompetencyScore> & { id: string; name: string }): CompetencyScore {
  return {
    level: 3, requiredLevel: 3, confidence: 0.8, notEnoughEvidence: false,
    evidence: [{ turnId: `t-${over.id}`, startMs: 0, endMs: 1, quote: `I led the ${over.name.toLowerCase()} work end to end.` }],
    rationale: 'Level 4 of 5 because of scope.', rubricVersion: 'r1',
    ...over,
  };
}

function assessment(competencies: CompetencyScore[]): AssessmentResult {
  return {
    assessmentVersion: 'A-1', roleScorecardVersion: 's1', recommendation: 'DO_NOT_PROGRESS',
    confidence: 0.71, evidenceCoverage: 0.64, overallScore: 38, competencies,
    strengths: ['Scored 4/5 on SQL'], concerns: ['Below the bar for leadership'],
    contradictions: [], openQuestions: [], limitations: [], summary: 'Overall 38/100, do not progress.',
  };
}

const MIXED = assessment([
  competency({ id: 'sql', name: 'SQL', level: 4, requiredLevel: 3,
    evidence: [{ turnId: 't1', startMs: 0, endMs: 1, quote: 'I rewrote the billing query with a window function and cut it from minutes to seconds.' }] }),
  competency({ id: 'pipelines', name: 'Data pipelines', level: 4, requiredLevel: 3 }),
  competency({ id: 'stakeholders', name: 'Stakeholder management', level: 2, requiredLevel: 3,
    evidence: [{ turnId: 't3', startMs: 0, endMs: 1, quote: 'I mostly sent the report and moved on.' }] }),
  competency({ id: 'testing', name: 'Testing', level: 1, requiredLevel: 3 }),
  // Never discussed: must not be described as something to work on.
  competency({ id: 'leadership', name: 'People leadership', level: null, notEnoughEvidence: true, evidence: [] }),
]);

function allText(content: FeedbackContent): string {
  return [...content.strengths, ...content.develop, ...content.suggestions].join('\n');
}

describe('feedback built from the evidence', () => {
  it('names each strong competency among the strengths', () => {
    const content = buildEvidenceFeedback(MIXED);
    expect(content.strengths.join(' ')).toContain('SQL');
  });

  it("quotes the candidate's own words as the basis for a strength", () => {
    const content = buildEvidenceFeedback(MIXED);
    expect(content.strengths.join(' ')).toContain('window function');
  });

  it('turns an evidenced shortfall into an area to develop', () => {
    const content = buildEvidenceFeedback(MIXED);
    expect(content.develop.join(' ')).toContain('Stakeholder management');
  });

  it('never describes a competency that was not discussed as something to work on', () => {
    const content = buildEvidenceFeedback(MIXED);
    expect(allText(content)).not.toContain('People leadership');
  });

  it('does not quote the same answer under two strengths', () => {
    const shared = 'I owned the billing pipeline end to end and made recovery safe to repeat.';
    const same = assessment([
      competency({ id: 'a', name: 'Ownership', level: 4, requiredLevel: 3, evidence: [{ turnId: 't', startMs: 0, endMs: 1, quote: shared }] }),
      competency({ id: 'b', name: 'Pipelines', level: 4, requiredLevel: 3, evidence: [{ turnId: 't', startMs: 0, endMs: 1, quote: shared }] }),
    ]);
    const quoted = buildEvidenceFeedback(same).strengths.filter((s) => s.includes('billing pipeline'));
    expect(quoted).toHaveLength(1);
  });

  it('gives two or three strengths, two or three areas and one or two suggestions', () => {
    expect(feedbackContentSchema.safeParse(buildEvidenceFeedback(MIXED)).success).toBe(true);
  });

  it('still has the full shape when only one competency was evidenced', () => {
    const one = assessment([competency({ id: 'sql', name: 'SQL', level: 5, requiredLevel: 3 })]);
    expect(feedbackContentSchema.safeParse(buildEvidenceFeedback(one)).success).toBe(true);
  });

  it('falls back to the generic wording when nothing was evidenced', () => {
    const none = assessment([competency({ id: 'x', name: 'SQL', level: null, notEnoughEvidence: true, evidence: [] })]);
    expect(buildEvidenceFeedback(none)).toEqual(GENERIC_FEEDBACK);
  });

  it('ignores a competency whose grading failed, which says nothing about the person', () => {
    const outage = assessment([competency({ id: 'sql', name: 'SQL', level: 2, requiredLevel: 3, gradingUnavailable: true })]);
    expect(allText(buildEvidenceFeedback(outage))).not.toContain('SQL');
  });

  it('passes its own guardrails', () => {
    expect(feedbackGuardrailViolations(buildEvidenceFeedback(MIXED))).toEqual([]);
  });

  it('the generic wording passes its own guardrails', () => {
    expect(feedbackGuardrailViolations(GENERIC_FEEDBACK)).toEqual([]);
  });
});

describe('what the model is shown', () => {
  it('carries no level, score, weight or recommendation for the model to repeat', () => {
    const input = JSON.stringify(feedbackPromptInput(MIXED));
    expect(input).not.toMatch(/level|score|weight|recommend|PROCEED|DO_NOT_PROGRESS|\b38\b|0\.71/i);
  });

  it('gives the model the evidenced competencies, bucketed', () => {
    const input = feedbackPromptInput(MIXED);
    expect(input.clearlyShown.map((c) => c.competency)).toEqual(['SQL', 'Data pipelines']);
  });

  it('leaves out competencies that were not discussed', () => {
    const input = JSON.stringify(feedbackPromptInput(MIXED));
    expect(input).not.toContain('People leadership');
  });
});

// Table-driven: every row is a sentence that must never reach a candidate.
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['a score', 'You scored well on SQL.'],
  ['a score out of five', 'Your SQL came out at 4/5 in this interview.'],
  ['a score out of a hundred', 'Overall you reached 72 out of 100 today.'],
  ['a level', 'Your SQL was at level 4, which is strong.'],
  ['a rating', 'We rated your answers on testing as developing.'],
  ['the recommendation', 'Our recommendation is to consider you further.'],
  ['a pass', 'You passed the technical section with room to spare.'],
  ['a fail', 'You failed to show enough depth on testing.'],
  ['a ranking', 'You ranked in the top third of this group.'],
  ['other candidates', 'Compared with other candidates your SQL stood out.'],
  ['a hiring decision', 'We have decided to move forward with your application.'],
  ['an offer', 'We would like to make you an offer.'],
  ['a rejection', 'Unfortunately we will not be progressing your application.'],
  ['a next-round promise', 'You will hear about the next round soon.'],
  ['weights', 'Testing carries the most weight for this role.'],
  ['the threshold', 'You were just below the threshold for this role.'],
  ['a percentage verdict', 'You matched 80% of what we need.'],
  ['a mention of AI', 'Our AI noticed you explained trade-offs clearly.'],
  ['a mention of automation', 'This automated summary shows your clearest answers.'],
  ['age-coded language', 'You bring the energy of a young team member.'],
  ['a protected characteristic', 'Your accent was easy to follow throughout.'],
  ['family status', 'Balancing this with your children must be hard.'],
  ['moving them forward', 'We are moving you forward to the next step.'],
  ['a next step in the process', 'The next steps will be shared with you shortly.'],
  ['advancing them', 'We will advance you to the technical stage.'],
  ['progressing them', 'We are progressing you to a conversation with the team.'],
  ['a shortlist', 'You are on the shortlist for this role.'],
  ['being selected', 'You have been selected for the next conversation.'],
  ['not being selected', 'You were not selected for this role on this occasion.'],
  ['an unsuccessful application', 'Your application was unsuccessful this time.'],
  ['a good fit', 'You are a good fit for this team.'],
  ['a strong fit', 'You were a strong fit for what we need.'],
  ['not a fit', 'You are not a fit for this role.'],
  ['proceeding', 'We will proceed with your candidacy.'],
  ['taking them through', 'We would like to take you through to the next stage.'],
];

function withStrength(sentence: string): FeedbackContent {
  return { ...GENERIC_FEEDBACK, strengths: [sentence, GENERIC_FEEDBACK.strengths[1]] };
}

describe('guardrails on what a candidate may be told', () => {
  it.each(FORBIDDEN)('refuses %s', (_label, sentence) => {
    expect(feedbackGuardrailViolations(withStrength(sentence)).length).toBeGreaterThan(0);
  });

  // The model is told to quote the candidate, so it can also put its own
  // words inside quotation marks. Stripping every quoted span before the
  // verdict checks would have let "We recommend moving you to the next step."
  // through as long as it was quoted.
  it.each(FORBIDDEN)('refuses %s even inside quotation marks', (_label, sentence) => {
    expect(feedbackGuardrailViolations(withStrength(`You might wonder about this: "${sentence}"`)).length).toBeGreaterThan(0);
  });

  it("does not treat the candidate's own quoted words as our verdict", () => {
    const quote = 'we detected the failure from alerts and passed the fix to the on-call team';
    const content = withStrength(`You described your incident work clearly: "${quote}".`);
    expect(feedbackGuardrailViolations(content, { evidenceQuotes: [quote] })).toEqual([]);
  });

  it('allows a quoted answer that happens to use decision words, when we put the quote there', () => {
    const quote = 'we moved forward with Qualtrics after the trial, and I owned the migration';
    const content = withStrength(`You were specific about your tooling choices: "${quote}".`);
    expect(feedbackGuardrailViolations(content, { evidenceQuotes: [quote] })).toEqual([]);
  });

  it('refuses the same wording when it is not a quote we inserted', () => {
    const content = withStrength('You were specific about your tooling choices: "we moved forward with your application".');
    expect(feedbackGuardrailViolations(content).length).toBeGreaterThan(0);
  });

  it('only forgives the exact quote, not a sentence the model built around it', () => {
    const quote = 'I owned the billing pipeline end to end';
    const content = withStrength(`You said: "${quote}, and we recommend moving you to the next step".`);
    expect(feedbackGuardrailViolations(content, { evidenceQuotes: [quote] }).length).toBeGreaterThan(0);
  });

  it('still refuses exclusionary wording inside a quote', () => {
    const quote = 'as a native speaker I handled every client call';
    expect(feedbackGuardrailViolations(withStrength(`You said: "${quote}".`), { evidenceQuotes: [quote] }).length).toBeGreaterThan(0);
  });
});

describe('choosing what goes out', () => {
  const MODEL: FeedbackContent = {
    strengths: [
      'You explained how you rewrote the billing query step by step, which made your reasoning easy to follow.',
      'You were specific about the pipeline you owned and how you made recovery safe to repeat.',
    ],
    develop: [
      'When you talked about working with stakeholders, there was room to say more about how you kept them involved.',
      'On testing, walking through how you decide what to test first would show more of your approach.',
    ],
    suggestions: ['Before your next interview, prepare one example of bringing a sceptical stakeholder along with a change.'],
  };

  it("uses the model's wording when it is valid and clean", () => {
    expect(chooseFeedbackContent({ model: MODEL, result: MIXED }).source).toBe('model');
  });

  it('falls back to the evidence wording when the model mentions a score', () => {
    const leaky: FeedbackContent = { ...MODEL, strengths: ['You scored 4/5 on SQL, which is excellent.', MODEL.strengths[1]] };
    expect(chooseFeedbackContent({ model: leaky, result: MIXED }).source).toBe('evidence');
  });

  it('falls back to the evidence wording when there is no model', () => {
    expect(chooseFeedbackContent({ model: null, result: MIXED }).source).toBe('evidence');
  });

  it('keeps the evidence wording when a quoted answer uses decision words', () => {
    const tooling = assessment([
      competency({ id: 'sql', name: 'SQL', level: 4, requiredLevel: 3,
        evidence: [{ turnId: 't', startMs: 0, endMs: 1, quote: 'we moved forward with Qualtrics after the trial and I owned the migration' }] }),
    ]);
    expect(chooseFeedbackContent({ model: null, result: tooling }).source).toBe('evidence');
  });

  it('refuses model wording that hides a decision inside quotation marks', () => {
    const leaky: FeedbackContent = { ...MODEL, strengths: ['You may like to know: "we are moving you forward to the next step".', MODEL.strengths[1]] };
    expect(chooseFeedbackContent({ model: leaky, result: MIXED }).source).toBe('evidence');
  });

  it('falls back to the generic wording when the evidence itself fails the checks', () => {
    const risky = assessment([
      competency({ id: 'sql', name: 'SQL', level: 4, requiredLevel: 3,
        evidence: [{ turnId: 't', startMs: 0, endMs: 1, quote: 'I did this while looking after my children at home.' }] }),
    ]);
    const chosen = chooseFeedbackContent({ model: null, result: risky });
    expect(chosen).toMatchObject({ source: 'generic', content: GENERIC_FEEDBACK });
  });
});
