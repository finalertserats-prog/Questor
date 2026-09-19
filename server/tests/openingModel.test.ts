import { describe, it, expect } from 'vitest';
import {
  WARMUP_QUESTION,
  buildOpeningGreeting,
  firstName,
  focusAreas,
} from '../src/engines/openingModel.js';
import type { Competency, RoleSuccessProfile } from '../src/domain/types.js';

// The interview opens like a real one: a greeting by name, what the role is
// mainly looking for (from the role's own scorecard), the time, and the first
// question. The AI disclosure lives on the consent screen, before this.

function competency(over: Partial<Competency> & { id: string; name: string }): Competency {
  return {
    definition: '', category: 'technical', classification: 'essential', weight: 0.2,
    requiredLevel: 2, targetLevel: 3, indicators: [], evidenceModes: [], ...over,
  } as Competency;
}

function role(competencies: Competency[]): RoleSuccessProfile {
  return {
    roleContext: '', outcomes: [], responsibilities: [], competencies,
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
    redFlags: [], seniority: 'Senior',
  };
}

const DATA_ROLE = role([
  competency({ id: 'c1', name: 'Collaboration', category: 'behavioral', weight: 0.3 }),
  competency({ id: 'c2', name: 'SQL & Data Warehousing', weight: 0.25 }),
  competency({ id: 'c3', name: 'Data Engineering & Pipelines', weight: 0.3 }),
  competency({ id: 'c4', name: 'Cloud Platform & Reliability', category: 'domain', weight: 0.2 }),
  competency({ id: 'c5', name: 'Machine Learning Exposure', classification: 'preferred', weight: 0.05 }),
]);

const base = {
  candidateName: 'Priya Sharma',
  interviewerName: 'Maya',
  roleTitle: 'Senior Data Engineer',
  focus: ['Data Engineering & Pipelines', 'SQL & Data Warehousing', 'Cloud Platform & Reliability'],
  durationMinutes: 45,
};

describe('firstName', () => {
  it('takes the first word of the full name', () => {
    expect(firstName('Priya Sharma')).toBe('Priya');
  });

  it('is empty for a missing name', () => {
    expect(firstName('   ')).toBe('');
  });
});

describe('focusAreas', () => {
  it('picks the heaviest role-specific competencies, at most three', () => {
    expect(focusAreas(DATA_ROLE)).toEqual(['Data Engineering & Pipelines', 'SQL & Data Warehousing', 'Cloud Platform & Reliability']);
  });

  it('fills from other competencies when the role has few role-specific ones', () => {
    const r = role([
      competency({ id: 'a', name: 'Stakeholder Management', category: 'behavioral', weight: 0.5 }),
      competency({ id: 'b', name: 'Salesforce Administration', weight: 0.5 }),
    ]);
    expect(focusAreas(r)).toEqual(['Salesforce Administration', 'Stakeholder Management']);
  });

  it('leaves out competencies that do not count towards the decision', () => {
    const r = role([competency({ id: 'a', name: 'Typing Speed', classification: 'non_scoring', weight: 0.9 }), competency({ id: 'b', name: 'Python', weight: 0.1 })]);
    expect(focusAreas(r)).toEqual(['Python']);
  });

  it('never repeats exclusionary wording from a scorecard', () => {
    const r = role([competency({ id: 'a', name: 'Young and energetic team player', weight: 0.9 }), competency({ id: 'b', name: 'Python', weight: 0.1 })]);
    expect(focusAreas(r)).toEqual(['Python']);
  });
});

describe('buildOpeningGreeting', () => {
  const opening = buildOpeningGreeting(base);

  it('greets the candidate by first name and gives the interviewer name', () => {
    expect(opening.startsWith("Hi Priya, I'm Maya — thanks for making the time today.")).toBe(true);
  });

  it('says what the role is mainly looking for, from the role data', () => {
    expect(opening).toContain("For this Senior Data Engineer role, we're mainly looking for strength in Data Engineering & Pipelines, SQL & Data Warehousing and Cloud Platform & Reliability.");
  });

  it('gives the length and the offer to repeat', () => {
    expect(opening).toContain("We'll spend about 45 minutes together, and feel free to ask me to repeat anything.");
  });

  it('ends by starting the interview with the warm-up question', () => {
    expect(opening.endsWith(`Let's start — ${WARMUP_QUESTION}`)).toBe(true);
  });

  it('does not read out the AI disclosure, which the consent screen carries', () => {
    expect(opening).not.toMatch(/AI interviewer|Questor|transcri|recording/i);
  });

  it('is identical for two interviewers apart from the name', () => {
    const theo = buildOpeningGreeting({ ...base, interviewerName: 'Theo' });
    expect(theo.replace('Theo', 'NAME')).toBe(opening.replace('Maya', 'NAME'));
  });

  it('greets without a name when the candidate record has none', () => {
    expect(buildOpeningGreeting({ ...base, candidateName: '' }).startsWith("Hi, I'm Maya — thanks for making the time today.")).toBe(true);
  });

  it('greets without introducing a name when the session records none', () => {
    expect(buildOpeningGreeting({ ...base, interviewerName: '' }).startsWith('Hi Priya — thanks for making the time today.')).toBe(true);
  });

  it('still says why we are here when the role has no usable focus areas', () => {
    expect(buildOpeningGreeting({ ...base, focus: [] })).toContain("For this Senior Data Engineer role, we'd like to hear how you've approached the work it involves.");
  });

  it('names two focus areas with "and"', () => {
    expect(buildOpeningGreeting({ ...base, focus: ['Python', 'SQL'] })).toContain('strength in Python and SQL.');
  });

  it('says "this role" when the title is missing', () => {
    expect(buildOpeningGreeting({ ...base, roleTitle: '' })).toContain("For this role, we're mainly looking for");
  });

  it('says aloud that a member of the hiring team may observe, when the candidate was told so', () => {
    const notice = 'A member of the hiring team may observe this interview live.';
    expect(buildOpeningGreeting({ ...base, observerNotice: notice })).toContain(`feel free to ask me to repeat anything. ${notice} Let's start`);
  });

  it('keeps to four sentences before the question', () => {
    const beforeQuestion = opening.slice(0, opening.indexOf("Let's start"));
    expect(beforeQuestion.match(/[.!?](\s|$)/g)).toHaveLength(3);
  });
});
