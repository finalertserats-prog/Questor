import { describe, it, expect } from 'vitest';
import type { AssessmentResult, Competency, CompetencyScore, RoleSuccessProfile } from '../src/domain/types.js';
import {
  GENERIC_SWOT, MARKER_LABEL, MARKER_SEGMENTS, buildEvidenceFeedback, chooseFeedbackContent,
  coverageMarker, feedbackContentSchema, feedbackGuardrailViolations, feedbackPromptInput,
  modelFeedbackSchema, textGuardrailViolations, type FeedbackContent, type ModelFeedback,
} from '../src/services/feedbackContentModel.js';

/**
 * What the candidate's feedback letter says. The owner's design asks for a
 * qualitative glance row per competency, a SWOT, a per-competency evidence
 * section and three next steps — all built from the real assessment, and none
 * of it allowed to carry a score, a level or a decision.
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

function profileCompetency(id: string, name: string, definition: string): Competency {
  return {
    id, name, definition, category: 'technical', classification: 'essential', weight: 0.5,
    requiredLevel: 3, targetLevel: 4, indicators: [`Shows ${name.toLowerCase()} in practice`], evidenceModes: [],
  };
}

const PROFILE: RoleSuccessProfile = {
  roleContext: 'Data team', outcomes: [], responsibilities: [],
  competencies: [
    profileCompetency('sql', 'SQL', 'Writing and tuning the queries the reporting stack runs on.'),
    profileCompetency('stake', 'Stakeholder management', 'Keeping the people who depend on the data involved in changes.'),
    profileCompetency('lead', 'People leadership', 'Growing the people around you.'),
  ],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};

const MIXED = assessment([
  competency({ id: 'sql', name: 'SQL', level: 4, requiredLevel: 3,
    evidence: [{ turnId: 't1', startMs: 0, endMs: 1, quote: 'I rewrote the billing query with a window function and cut it from minutes to seconds.' }] }),
  competency({ id: 'stake', name: 'Stakeholder management', level: 2, requiredLevel: 3,
    evidence: [{ turnId: 't3', startMs: 0, endMs: 1, quote: 'I mostly sent the report and moved on.' }] }),
  competency({ id: 'lead', name: 'People leadership', level: null, notEnoughEvidence: true, evidence: [] }),
]);

const INPUT = { result: MIXED, profile: PROFILE };

function allProse(content: FeedbackContent): string {
  return [
    ...content.swot.strengths, ...content.swot.weaknesses, ...content.swot.opportunities, ...content.swot.watchOuts,
    ...content.nextSteps,
    ...content.competencies.flatMap((c) => [c.name, c.roleAsks, c.whatWeHeard, c.toGoFurther, c.quote]),
  ].join('\n');
}

describe('how each competency is marked', () => {
  it('calls an evidenced competency at or above what the role asks a clear strength', () => {
    expect(coverageMarker(competency({ id: 'a', name: 'A', level: 4, requiredLevel: 3 }))).toBe('strength');
  });

  it('calls an evidenced competency below it partly shown', () => {
    expect(coverageMarker(competency({ id: 'a', name: 'A', level: 2, requiredLevel: 3 }))).toBe('partly');
  });

  it('calls a competency with no evidence not covered', () => {
    expect(coverageMarker(competency({ id: 'a', name: 'A', level: null, notEnoughEvidence: true, evidence: [] }))).toBe('not-covered');
  });

  it('calls a competency whose grading failed not covered, never a shortfall', () => {
    expect(coverageMarker(competency({ id: 'a', name: 'A', level: 1, requiredLevel: 3, gradingUnavailable: true }))).toBe('not-covered');
  });

  it('words the markers the way the design does', () => {
    expect([MARKER_LABEL.strength, MARKER_LABEL.partly, MARKER_LABEL['not-covered']])
      .toEqual(['Clear strength', 'Partly shown', 'Not covered']);
  });

  it('fills the four-segment bar without ever stating a number', () => {
    expect([MARKER_SEGMENTS.strength, MARKER_SEGMENTS.partly, MARKER_SEGMENTS['not-covered']]).toEqual([3, 2, 0]);
  });
});

describe('the letter built from the evidence', () => {
  const content = buildEvidenceFeedback(INPUT);

  it('has the shape the design asks for', () => {
    expect(feedbackContentSchema.safeParse(content).success).toBe(true);
  });

  it('keeps every competency, including the ones that never came up', () => {
    expect(content.competencies.map((c) => c.name)).toEqual(['SQL', 'Stakeholder management', 'People leadership']);
  });

  it('marks each one as the conversation actually went', () => {
    expect(content.competencies.map((c) => c.marker)).toEqual(['strength', 'partly', 'not-covered']);
  });

  it("takes 'the role asks for' from the scorecard rather than inventing it", () => {
    expect(content.competencies[0].roleAsks).toContain('reporting stack');
  });

  it("quotes the candidate's own words under the competency they belong to", () => {
    expect(content.competencies[0].quote).toContain('window function');
  });

  it('has no quote for something that never came up', () => {
    expect(content.competencies[2].quote).toBe('');
  });

  it('says a competency that never came up was not covered, not that it was a failing', () => {
    expect(content.competencies[2].whatWeHeard).toMatch(/did not come up/i);
  });

  it('still tells them how to go further on what was not covered', () => {
    expect(content.competencies[2].toGoFurther.length).toBeGreaterThan(20);
  });

  it('gives two or three bullets in each SWOT quarter', () => {
    for (const quarter of [content.swot.strengths, content.swot.weaknesses, content.swot.opportunities, content.swot.watchOuts]) {
      expect(quarter.length).toBeGreaterThanOrEqual(2);
      expect(quarter.length).toBeLessThanOrEqual(3);
    }
  });

  it('draws a strength from a competency the candidate actually showed', () => {
    expect(content.swot.strengths.join(' ')).toContain('SQL');
  });

  it('gives three next steps', () => {
    expect(content.nextSteps).toHaveLength(3);
  });

  it('passes its own guardrails', () => {
    expect(feedbackGuardrailViolations(content)).toEqual([]);
  });

  it('works when there is no scorecard to read the role from', () => {
    const noProfile = buildEvidenceFeedback({ result: MIXED, profile: null });
    expect(feedbackContentSchema.safeParse(noProfile).success).toBe(true);
  });

  it('holds its shape when nothing at all was evidenced', () => {
    const empty = assessment([competency({ id: 'sql', name: 'SQL', level: null, notEnoughEvidence: true, evidence: [] })]);
    const content = buildEvidenceFeedback({ result: empty, profile: PROFILE });
    expect(feedbackContentSchema.safeParse(content).success).toBe(true);
  });

  it('never claims a strength when nothing was evidenced', () => {
    const empty = assessment([competency({ id: 'sql', name: 'SQL', level: null, notEnoughEvidence: true, evidence: [] })]);
    expect(buildEvidenceFeedback({ result: empty, profile: PROFILE }).swot.strengths).toEqual(GENERIC_SWOT.strengths);
  });
});

describe('what the model is shown', () => {
  it('carries no level, score, weight or recommendation for it to repeat', () => {
    const input = JSON.stringify(feedbackPromptInput(INPUT));
    expect(input).not.toMatch(/level|score|weight|recommend|PROCEED|DO_NOT_PROGRESS|\b38\b|0\.71/i);
  });

  it('tells the model how each competency was covered, in words', () => {
    expect(feedbackPromptInput(INPUT).competencies.map((c) => c.coverage))
      .toEqual(['Clear strength', 'Partly shown', 'Not covered']);
  });
});

// Table-driven: every row is a sentence that must never reach a candidate.
const FORBIDDEN: ReadonlyArray<readonly [string, string]> = [
  ['a score', 'You scored well on SQL.'],
  ['a score out of five', 'Your SQL came out at 4/5 in this interview.'],
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
  ['a percentage verdict', 'You matched 80% of what we need.'],
  ['a mention of AI', 'Our AI noticed you explained trade-offs clearly.'],
  ['moving them forward', 'We are moving you forward to the next step.'],
  ['being selected', 'You have been selected for the next conversation.'],
  ['a good fit', 'You are a good fit for this team.'],
  ['age-coded language', 'You bring the energy of a young team member.'],
  ['a protected characteristic', 'Your accent was easy to follow throughout.'],
];

function withStrength(sentence: string): FeedbackContent {
  const base = buildEvidenceFeedback(INPUT);
  return { ...base, swot: { ...base.swot, strengths: [sentence, base.swot.strengths[1]] } };
}

describe('guardrails on what a candidate may be told', () => {
  it.each(FORBIDDEN)('refuses %s', (_label, sentence) => {
    expect(feedbackGuardrailViolations(withStrength(sentence)).length).toBeGreaterThan(0);
  });

  // The model writes prose, not quotations: wrapping a verdict in quotation
  // marks must not buy it a way through.
  it.each(FORBIDDEN)('refuses %s even inside quotation marks', (_label, sentence) => {
    expect(feedbackGuardrailViolations(withStrength(`You might wonder: "${sentence}"`)).length).toBeGreaterThan(0);
  });

  it("does not read the candidate's own quoted words as our verdict", () => {
    const base = buildEvidenceFeedback(INPUT);
    const quoted = {
      ...base,
      competencies: base.competencies.map((c, i) => (i === 0
        ? { ...c, quote: 'we moved forward with Qualtrics after the trial, and I passed the fix to on-call' }
        : c)),
    };
    expect(feedbackGuardrailViolations(quoted)).toEqual([]);
  });

  it('refuses exclusionary wording even inside a quote', () => {
    const base = buildEvidenceFeedback(INPUT);
    const quoted = {
      ...base,
      competencies: base.competencies.map((c, i) => (i === 0 ? { ...c, quote: 'as a native speaker I handled every client call' } : c)),
    };
    expect(feedbackGuardrailViolations(quoted).length).toBeGreaterThan(0);
  });

  it('refuses a verdict hidden in what the role asks for', () => {
    const base = buildEvidenceFeedback(INPUT);
    const risky = {
      ...base,
      competencies: base.competencies.map((c, i) => (i === 0 ? { ...c, whatWeHeard: 'You scored higher than most on this.' } : c)),
    };
    expect(feedbackGuardrailViolations(risky).length).toBeGreaterThan(0);
  });
});

// The candidate's own words and the employer's job description reach the
// letter verbatim, so they get the same sweep for numbers, levels, verdicts
// and AI — and the field is dropped or plain-worded, never the whole letter.
const RISKY_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['a score', 'I passed the last assessment with 90%.'],
  ['a level', 'They put me at level 5 straight away.'],
  ['a verdict', 'We were told we had been shortlisted for the panel.'],
  ['a ranking', 'I was ranked first in my cohort.'],
  ['AI', 'I used an AI to draft the first version of the script.'],
];

describe("the candidate's own words, when they carry a number or a verdict", () => {
  it.each(RISKY_QUOTES)('are left out of the letter when they carry %s', (_label, quote) => {
    const risky = assessment([competency({ id: 'sql', name: 'SQL', level: 4, requiredLevel: 3,
      evidence: [{ turnId: 't', startMs: 0, endMs: 1, quote }] })]);
    const content = buildEvidenceFeedback({ result: risky, profile: PROFILE });
    expect(content.competencies[0].quote).toBe('');
  });

  it('are replaced by the next clean quote when there is one', () => {
    const risky = assessment([competency({ id: 'sql', name: 'SQL', level: 4, requiredLevel: 3,
      evidence: [
        { turnId: 't1', startMs: 0, endMs: 1, quote: 'I passed the last assessment with 90%.' },
        { turnId: 't2', startMs: 0, endMs: 1, quote: 'I rewrote the billing query with a window function.' },
      ] })]);
    expect(buildEvidenceFeedback({ result: risky, profile: PROFILE }).competencies[0].quote).toContain('window function');
  });

  it('still leave the rest of the letter intact', () => {
    const risky = assessment([competency({ id: 'sql', name: 'SQL', level: 4, requiredLevel: 3,
      evidence: [{ turnId: 't', startMs: 0, endMs: 1, quote: 'I passed the last assessment with 90%.' }] })]);
    const content = buildEvidenceFeedback({ result: risky, profile: PROFILE });
    expect({ marker: content.competencies[0].marker, violations: feedbackGuardrailViolations(content) })
      .toEqual({ marker: 'strength', violations: [] });
  });
});

const RISKY_DEFINITIONS: ReadonlyArray<readonly [string, string]> = [
  ['a level', 'Level 5 SQL; anything below is a shortlist criterion.'],
  ['a score', 'Must score at least 80% on the take-home.'],
  ['a decision word', 'Candidates we would hire on this alone.'],
  ['AI', 'Uses AI tooling to write queries.'],
];

describe('what the role asks for, when the scorecard wording would read as a verdict', () => {
  it.each(RISKY_DEFINITIONS)('is put in plain words when it carries %s', (_label, definition) => {
    const profile = { ...PROFILE, competencies: [profileCompetency('sql', 'SQL', definition)] };
    const content = buildEvidenceFeedback({ result: MIXED, profile });
    expect(content.competencies[0].roleAsks).toBe('Showing SQL in the work you do day to day.');
  });

  it('is kept when the wording is clean', () => {
    expect(buildEvidenceFeedback(INPUT).competencies[0].roleAsks).toContain('reporting stack');
  });
});

describe('the guardrails, on what is already in the letter', () => {
  it('refuse a quote that slipped through with a verdict in it', () => {
    const base = buildEvidenceFeedback(INPUT);
    const quoted = { ...base, competencies: base.competencies.map((c, i) => (i === 0 ? { ...c, quote: 'I passed with 90%.' } : c)) };
    expect(feedbackGuardrailViolations(quoted).length).toBeGreaterThan(0);
  });

  it('refuse a role description that slipped through with a level in it', () => {
    const base = buildEvidenceFeedback(INPUT);
    const risky = { ...base, competencies: base.competencies.map((c, i) => (i === 0 ? { ...c, roleAsks: 'Level 5 SQL only.' } : c)) };
    expect(feedbackGuardrailViolations(risky).length).toBeGreaterThan(0);
  });

  it('check a single sentence the same way, for the fixed wording of the email', () => {
    expect(textGuardrailViolations('We will be in touch about next steps.').length).toBeGreaterThan(0);
  });

  it('let a plain sentence through', () => {
    expect(textGuardrailViolations('Thank you for your time.')).toEqual([]);
  });
});

describe('choosing what goes out', () => {
  const MODEL: ModelFeedback = {
    swot: {
      strengths: ['You walked through the billing query rewrite in a way that was easy to follow.', 'You were specific about what you changed and why.'],
      weaknesses: ['Your examples often stop before the result, so the impact is left unsaid.', 'Work with stakeholders is described briefly.'],
      opportunities: ['Your habit of tuning queries before anyone complains is worth leading with.', 'One concrete number per story would lift every answer.'],
      watchOuts: ['Long answers drift, and the strongest point often arrives last.', 'Saying "we" where it was you reads as a smaller part than you had.'],
    },
    notes: [
      { competencyId: 'sql', whatWeHeard: 'A billing query you rewrote yourself, with the effect on run time spelled out.', toGoFurther: 'Name what the slow query was costing the team before you touched it.' },
      { competencyId: 'stake', whatWeHeard: 'A report you sent on, with little about how you kept people involved afterwards.', toGoFurther: 'Describe how you brought a sceptical stakeholder along with a change.' },
    ],
    nextSteps: [
      'Add the ending to three of your stories: what changed, and how you knew.',
      'Re-tell one story naming your own decisions rather than the team\'s.',
      'Have one short example ready about growing the people around you.',
    ],
  };

  it("uses the model's wording when it passes", () => {
    const chosen = chooseFeedbackContent({ model: MODEL, input: INPUT });
    expect({ source: chosen.source, heard: chosen.content.competencies[0].whatWeHeard })
      .toEqual({ source: 'model', heard: MODEL.notes[0].whatWeHeard });
  });

  it('keeps the facts ours even when the model writes the prose', () => {
    const chosen = chooseFeedbackContent({ model: MODEL, input: INPUT });
    expect({ quote: chosen.content.competencies[0].quote, marker: chosen.content.competencies[0].marker })
      .toEqual({ quote: MIXED.competencies[0].evidence[0].quote, marker: 'strength' });
  });

  it('falls back to the evidence wording when the model leaks a score', () => {
    const leaky: ModelFeedback = { ...MODEL, swot: { ...MODEL.swot, strengths: ['You scored 4 out of 5 on SQL.', MODEL.swot.strengths[1]] } };
    expect(chooseFeedbackContent({ model: leaky, input: INPUT }).source).toBe('evidence');
  });

  it('falls back to the evidence wording when there is no model', () => {
    expect(chooseFeedbackContent({ model: null, input: INPUT }).source).toBe('evidence');
  });

  it('ignores model notes for competencies that do not exist', () => {
    const strays: ModelFeedback = { ...MODEL, notes: [...MODEL.notes, { competencyId: 'ghost', whatWeHeard: 'Nothing at all.', toGoFurther: 'Nothing at all either.' }] };
    expect(chooseFeedbackContent({ model: strays, input: INPUT }).content.competencies.map((c) => c.name))
      .toEqual(['SQL', 'Stakeholder management', 'People leadership']);
  });

  it('refuses a model reply that is the wrong shape', () => {
    expect(modelFeedbackSchema.safeParse({ swot: { strengths: ['one'] } }).success).toBe(false);
  });
});
