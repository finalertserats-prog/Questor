import { describe, it, expect, vi } from 'vitest';
import type { Competency, DirectorSignal, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

// The LLM path gets the same honesty rule as the deterministic detector: if
// asked, say it is an AI and that a person reviews the interview; never claim
// to be human. The model call is captured, not made.

const captured = vi.hoisted(() => ({ systems: [] as string[] }));
// Only the live interviewer prompt is of interest; a work-sample prompt may also run.
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

const { nextUtterance } = await import('../src/engines/conversationRuntime.js');
const { buildInterviewPlan } = await import('../src/engines/interviewPlanner.js');

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
const signal: DirectorSignal = { nextCompetencyId: TECH.id, action: 'ask', depthInstruction: 'hold', timeRemainingMinutes: 20, coverageState: { [TECH.id]: 0 }, reason: 't' };
const turns: TurnRecord[] = [
  { id: 'a', index: 0, speaker: 'agent', text: 'Tell me about a pipeline you owned.', startMs: 0, endMs: 1, confidence: 1, competencyId: TECH.id },
  { id: 'b', index: 1, speaker: 'candidate', text: 'I built the billing pipeline on Airflow and dbt.', startMs: 1, endMs: 2, confidence: 1, competencyId: TECH.id },
];

describe('live interviewer prompt', () => {
  it('tells the model to answer truthfully that it is an AI if asked', async () => {
    await nextUtterance({ plan: buildInterviewPlan({ role: ROLE, durationMinutes: 45 }), signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(captured.systems.at(-1)).toContain('If the candidate asks whether they are talking to an AI, a bot or a real person, say truthfully that you are an AI interviewer and that a person on the hiring team reviews the interview, then continue.');
  });

  it('forbids claiming to be human', async () => {
    await nextUtterance({ plan: buildInterviewPlan({ role: ROLE, durationMinutes: 45 }), signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(captured.systems.at(-1)).toContain('NEVER claim or imply that you are human.');
  });
});
