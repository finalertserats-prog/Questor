import { describe, it, expect } from 'vitest';
import type { Competency, DirectorSignal, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';
import type { TechStackItem } from '../src/domain/techStack.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { evaluate } from '../src/engines/evaluator.js';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { nextUtterance, type Persona } from '../src/engines/conversationRuntime.js';
import { extractRoleHeuristic } from '../src/engines/roleIntelligence.js';

/**
 * The stack reaching the engines end to end: the plan phrases a technical
 * block around the technology, the assessment reports which required
 * technologies had evidence, the fit score names the ones a resume lacks,
 * and a role drafted with a stack starts with a competency for each.
 * LLM_PROVIDER is heuristic here, so every path is the deterministic one.
 */

const KAFKA: TechStackItem = { name: 'Kafka', category: 'data', level: 'strong', required: true };
const REACT: TechStackItem = { name: 'React', category: 'framework', level: 'working', required: true };

const competency = (over: Partial<Competency>): Competency => ({
  id: 'c1', name: 'Kafka', definition: 'Runs streaming pipelines on Kafka.', category: 'technical', classification: 'essential',
  weight: 1, requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: ['technical_explanation'], ...over,
});

const role = (competencies: Competency[]): RoleSuccessProfile => ({
  roleContext: 'Streaming role.', outcomes: [], responsibilities: [], competencies,
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Senior',
});

const turn = (over: Partial<TurnRecord> & { speaker: TurnRecord['speaker']; text: string }): TurnRecord =>
  ({ id: Math.random().toString(36).slice(2), index: 0, startMs: 0, endMs: 1000, confidence: 1, ...over });

describe('the plan', () => {
  it('phrases a technical block about a required technology around it', () => {
    const plan = buildInterviewPlan({ role: role([competency({})]), techStack: [KAFKA] });
    expect(plan.blocks.find((b) => b.competencyId === 'c1')?.intent).toMatch(/how they have used Kafka in production/);
  });

  it('keeps the generic intent when the role has no stack', () => {
    const plan = buildInterviewPlan({ role: role([competency({})]) });
    expect(plan.blocks.find((b) => b.competencyId === 'c1')?.intent).toMatch(/^Assess depth in Kafka: ask the candidate/);
  });
});

describe('the assessment', () => {
  const turns = [
    turn({ speaker: 'agent', text: 'Tell me about a pipeline you ran.', competencyId: 'c1' }),
    turn({ speaker: 'candidate', text: 'I designed the Kafka topics and ran the consumers for the order pipeline, which cut lag by 40% after I tuned partitions.', competencyId: 'c1' }),
  ];

  it('reports the required technologies the interview evidenced', async () => {
    const result = await evaluate({ role: role([competency({})]), turns, rubricVersion: 'v1', assessmentVersion: 'A1', techStack: [KAFKA, REACT] });
    expect(result.techStackCoverage?.map((c) => `${c.name}:${c.evidenced}`)).toEqual(['Kafka:true', 'React:false']);
  });

  it('lists an unevidenced required technology as an open question, not a concern', async () => {
    const result = await evaluate({ role: role([competency({})]), turns, rubricVersion: 'v1', assessmentVersion: 'A1', techStack: [REACT] });
    expect({ open: result.openQuestions.some((q) => /No evidence of React/.test(q)), concern: result.concerns.some((q) => /React/.test(q)) }).toEqual({ open: true, concern: false });
  });

  it('leaves the field out when the role has no stack', async () => {
    const result = await evaluate({ role: role([competency({})]), turns, rubricVersion: 'v1', assessmentVersion: 'A1' });
    expect(result.techStackCoverage).toBeUndefined();
  });
});

describe('the fit score', () => {
  it('names a required technology the resume never mentions as missing', () => {
    const { fit } = computeFitScore({ employment: [], education: [], projects: [], certifications: [], skills: [] }, 'Built dashboards in React for three years.', role([competency({})]), [KAFKA, REACT]);
    expect(fit.missing).toContain('Kafka (required technology)');
  });

  it('adds a probe for it', () => {
    const { fit } = computeFitScore({ employment: [], education: [], projects: [], certifications: [], skills: [] }, 'Built dashboards in React.', role([competency({})]), [KAFKA]);
    expect(fit.probes.some((p) => p.startsWith('Probe Kafka:'))).toBe(true);
  });
});

describe('the live interviewer', () => {
  const PERSONA: Persona = { name: 'Maya', tone: 'warm' };
  const signal: DirectorSignal = { nextCompetencyId: 'c1', action: 'ask', depthInstruction: 'hold', timeRemainingMinutes: 20, coverageState: {}, reason: 'test' };

  it('still asks a question from the built-in bank with a stack present', async () => {
    const profile = role([competency({})]);
    const plan = buildInterviewPlan({ role: profile, techStack: [KAFKA] });
    const turns = [turn({ speaker: 'agent', text: 'Welcome.', competencyId: '__process__' }), turn({ speaker: 'candidate', text: 'Thanks, ready.', competencyId: '__process__' })];
    const utter = await nextUtterance({ plan, signal, turns, role: profile, persona: PERSONA, techStack: [KAFKA] });
    expect(utter.text.length).toBeGreaterThan(10);
  });
});

describe('drafting a role with a stack', () => {
  it('starts the scorecard with a technical competency per required technology', () => {
    const extraction = extractRoleHeuristic('We need someone to build services and collaborate with product.', 'Platform Engineer', { techStack: [KAFKA, REACT], band: 'senior' });
    expect(extraction.profile.competencies.filter((c) => ['Kafka', 'React'].includes(c.name)).map((c) => c.requiredLevel)).toEqual([4, 3]);
  });

  it('keeps the scored weights summing to one', () => {
    const extraction = extractRoleHeuristic('We need someone to build services.', 'Platform Engineer', { techStack: [KAFKA] });
    const total = extraction.profile.competencies.filter((c) => c.classification !== 'non_scoring').reduce((s, c) => s + c.weight, 0);
    expect(Math.round(total * 100)).toBe(100);
  });
});
