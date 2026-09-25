import { describe, it, expect } from 'vitest';
import type { Competency, DirectorSignal, NormalizedProfile, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';
import { anchoredCvQuestion, cvAnchorsFrom, MAX_CV_ANCHORS } from '../src/engines/cvAnchors.js';
import { normalizeProfile } from '../src/engines/resumeParser.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { nextUtterance } from '../src/engines/conversationRuntime.js';
import { answersNeeded } from '../src/engines/interviewDirector.js';
import { DEMO_RESUME } from '../src/seed/demoData.js';

/**
 * L3 of identity assurance: one or two questions anchored in specifics of the
 * candidate's own CV. Someone who did the work answers them fluently; a
 * stand-in has to improvise someone else's history.
 */

const TECH: Competency = {
  id: 'c_tech', name: 'Data Engineering & Pipelines', definition: '', category: 'technical',
  classification: 'essential', weight: 1, requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: [],
};
const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [], competencies: [TECH],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};
const PROFILE = normalizeProfile(DEMO_RESUME);
const EMPTY: NormalizedProfile = { employment: [], education: [], projects: [], certifications: [], skills: [] };
const resumeBlock = (plan: ReturnType<typeof buildInterviewPlan>) => plan.blocks.find((b) => b.competencyId === '__resume_validation__');

describe('choosing CV details to ask about', () => {
  it('picks at most two', () => {
    expect([MAX_CV_ANCHORS, cvAnchorsFrom(PROFILE).length]).toEqual([2, 2]);
  });

  it('takes the first from the most recent job', () => {
    expect(PROFILE.employment[0].bullets).toContain(cvAnchorsFrom(PROFILE)[0].fact);
  });

  it('takes the second from an earlier job, so the two cover different work', () => {
    expect(PROFILE.employment[1].bullets).toContain(cvAnchorsFrom(PROFILE)[1].fact);
  });

  it('prefers a line with something concrete in it (a number, a result)', () => {
    expect(cvAnchorsFrom(PROFILE)[0].fact).toMatch(/\d/);
  });

  it('quotes the CV line in the question', () => {
    const [first] = cvAnchorsFrom(PROFILE);
    expect(first.question).toContain(`"${first.fact}"`);
  });

  it('has nothing to ask about for an empty CV', () => {
    expect(cvAnchorsFrom(EMPTY)).toEqual([]);
  });

  it('falls back to a project when there is no job history', () => {
    const anchors = cvAnchorsFrom({ ...EMPTY, projects: [{ name: 'Ledger', summary: 'Built a double-entry ledger service handling 2M postings a day.' }] });
    expect(anchors.map((a) => a.source)).toEqual(['project']);
  });

  it('shortens a very long CV line rather than reading it all out', () => {
    const long = `Led ${'a very long initiative '.repeat(20)}to completion.`;
    const anchors = cvAnchorsFrom({ ...EMPTY, employment: [{ title: 'Engineer', company: 'Acme', bullets: [long] }] });
    expect(anchors[0].fact.length).toBeLessThanOrEqual(161);
  });
});

describe('the plan', () => {
  it('turns the resume check into the CV-anchored questions', () => {
    const plan = buildInterviewPlan({ role: ROLE, durationMinutes: 45, cvAnchors: cvAnchorsFrom(PROFILE) });
    expect(resumeBlock(plan)?.cvAnchors?.length).toBe(2);
  });

  it('leaves the resume check as it was when there are no CV details', () => {
    const plan = buildInterviewPlan({ role: ROLE, durationMinutes: 45 });
    expect(resumeBlock(plan)?.cvAnchors).toBeUndefined();
  });

  it('asks for one answer per CV detail, never more than two', () => {
    const plan = buildInterviewPlan({ role: ROLE, durationMinutes: 45, cvAnchors: cvAnchorsFrom(PROFILE) });
    expect(answersNeeded(resumeBlock(plan)!)).toBe(2);
  });
});

describe('asking the questions', () => {
  const plan = buildInterviewPlan({ role: ROLE, durationMinutes: 45, cvAnchors: cvAnchorsFrom(PROFILE) });
  const block = resumeBlock(plan)!;
  const [first, second] = block.cvAnchors!;
  const turn = (index: number, speaker: TurnRecord['speaker'], text: string, competencyId: string): TurnRecord =>
    ({ id: `t${index}`, index, speaker, text, startMs: 0, endMs: 0, confidence: 1, competencyId });

  it('asks the first CV question first', () => {
    expect(anchoredCvQuestion(block, [])).toBe(first.question);
  });

  it('asks the second once the first has been asked', () => {
    const turns = [turn(0, 'agent', `Thanks. ${first.question}`, block.competencyId), turn(1, 'candidate', 'We moved it over in stages.', block.competencyId)];
    expect(anchoredCvQuestion(block, turns)).toBe(second.question);
  });

  it('has nothing more once both have been asked', () => {
    const turns = [turn(0, 'agent', first.question, block.competencyId), turn(1, 'agent', second.question, block.competencyId)];
    expect(anchoredCvQuestion(block, turns)).toBeNull();
  });

  it('is what the interviewer says when the resume block comes up', async () => {
    const signal: DirectorSignal = {
      nextCompetencyId: '__resume_validation__', action: 'ask', depthInstruction: 'hold',
      timeRemainingMinutes: 10, coverageState: { [TECH.id]: 3 }, reason: 't',
    };
    const turns = [
      turn(0, 'agent', 'Tell me about a pipeline you owned.', TECH.id),
      turn(1, 'candidate', 'I owned the nightly billing pipeline end to end and cut failures by half.', TECH.id),
    ];
    const u = await nextUtterance({ plan, signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect([u.competencyId, u.text.includes(first.question)]).toEqual(['__resume_validation__', true]);
  });
});
