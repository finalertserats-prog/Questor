import { describe, it, expect, vi } from 'vitest';
import type { Competency, DirectorSignal, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

// The interviewer must never ask about a protected characteristic, wherever the
// employer is. The list is the common core of US, UK, EU and Indian law, not one
// country's: the prompt, the role default and the deterministic screen all use it.

const captured = vi.hoisted(() => ({ systems: [] as string[] }));
vi.mock('../src/providers/llm/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/llm/index.js')>();
  return {
    ...actual,
    generateJson: async (req: { system: string; fn: string }) => {
      if (req.fn === 'live_interviewer') captured.systems.push(req.system);
      return req.fn === 'live_interviewer' ? { question: 'What made you choose that design over a simpler one?' } : null;
    },
  };
});

const { screenQuestion, PROTECTED_TOPICS } = await import('../src/engines/policyEngine.js');
const { nextUtterance } = await import('../src/engines/conversationRuntime.js');
const { buildInterviewPlan } = await import('../src/engines/interviewPlanner.js');
const { extractRoleHeuristic } = await import('../src/engines/roleIntelligence.js');

const REQUIRED = [
  'race', 'ethnicity', 'colour', 'sex', 'gender', 'gender identity', 'sexual orientation', 'pregnancy',
  'marital status', 'family status', 'disability', 'age', 'religion', 'national origin', 'caste',
];

describe('protected topics list', () => {
  it.each(REQUIRED)('covers %s', (topic) => {
    expect(PROTECTED_TOPICS).toContain(topic);
  });

  it('is the default prohibited list for a new role', () => {
    const ext = extractRoleHeuristic('We need a backend engineer who writes Go.', 'Backend Engineer');
    expect(ext.profile.policyRules.prohibitedTopics).toEqual(expect.arrayContaining([...PROTECTED_TOPICS]));
  });
});

describe('screenQuestion on protected characteristics', () => {
  it.each([
    ['race', 'What race are you?'],
    ['race', 'Could you tell me your ethnicity?'],
    ['race', 'What is your ethnic background?'],
    ['colour', 'What is your skin colour?'],
    ['colour', 'What skin color would you describe yourself as?'],
    ['sex', 'Are you a man or a woman?'],
    ['sex', 'What is your gender?'],
    ['gender identity', 'Do you identify as transgender?'],
    ['orientation', 'What is your sexual orientation?'],
    ['orientation', 'Do you have a boyfriend or a girlfriend?'],
    ['pregnancy', 'Are you pregnant at the moment?'],
    ['pregnancy', 'Are you planning to have kids soon?'],
    ['family', 'Do you have any kids?'],
    ['disability', 'Do you have a disability we should know about?'],
    ['age', 'What year were you born?'],
    ['religion', 'Do you go to church?'],
    ['national origin', 'Where were you born?'],
    ['national origin', 'What country are you from?'],
    ['caste', 'What is your caste?'],
  ])('blocks a question about %s: %s', (_topic, question) => {
    expect(screenQuestion(question).allowed).toBe(false);
  });

  it.each([
    'How did you track down the race condition in the payment worker?',
    'Which colour palette did you choose for the dashboard, and why?',
    'How did you model the gender field when migrating the HR schema?',
    'How did you handle the age of cached records in that service?',
    'Tell me about a data pipeline you built.',
  ])('allows an ordinary work question: %s', (question) => {
    expect(screenQuestion(question).allowed).toBe(true);
  });
});

const TECH: Competency = {
  id: 'c_tech', name: 'Data Engineering & Pipelines', definition: '', category: 'technical',
  classification: 'essential', weight: 1, requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: [],
};
const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [], competencies: [TECH],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'US' },
  redFlags: [], seniority: 'Mid',
};
const signal: DirectorSignal = { nextCompetencyId: TECH.id, action: 'ask', depthInstruction: 'hold', timeRemainingMinutes: 20, coverageState: { [TECH.id]: 0 }, reason: 't' };
const turns: TurnRecord[] = [
  { id: 'a', index: 0, speaker: 'agent', text: 'Tell me about a pipeline you owned.', startMs: 0, endMs: 1, confidence: 1, competencyId: TECH.id },
  { id: 'b', index: 1, speaker: 'candidate', text: 'I built the billing pipeline on Airflow and dbt.', startMs: 1, endMs: 2, confidence: 1, competencyId: TECH.id },
];

describe('live interviewer prompt', () => {
  it.each(REQUIRED)('tells the model never to ask about %s', async (topic) => {
    await nextUtterance({ plan: buildInterviewPlan({ role: ROLE, durationMinutes: 45 }), signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    const line = (captured.systems.at(-1) ?? '').split('. ').find((s) => s.startsWith('NEVER ask about')) ?? '';
    expect(line).toContain(topic);
  });
});
