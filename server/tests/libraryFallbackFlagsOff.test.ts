import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmApiError, type LlmMessage, type LlmProvider, type LlmResult } from '../src/providers/llm/types.js';
import type { Competency, DirectorSignal, InterviewPlan, PlanBlock, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

/**
 * With LIBRARY_ENABLED and LOCAL_LLM_ENABLED both off (the defaults), the two
 * lanes together must behave as production did before either: the turn's
 * stored metadata is { kind, question } and nothing else, and no fallback
 * mode exists, so a failing primary goes straight to the built-in writer.
 */

const { config } = await import('../src/config.js');
const { _setLlmForTests } = await import('../src/providers/llm/index.js');
const { nextUtterance } = await import('../src/engines/conversationRuntime.js');
const { buildInterviewPlan } = await import('../src/engines/interviewPlanner.js');
const { traceServing } = await import('../src/providers/llm/servingTrace.js');
const { agentTurnMeta } = await import('../src/realtime/interviewEngine.js');

class FailingProvider implements LlmProvider {
  name = 'openai';
  enabled = true;
  calls = 0;
  interviewerCalls = 0;
  async generate(m: LlmMessage[]): Promise<LlmResult> {
    this.calls++;
    if (m[0].content.includes('AI interviewer')) this.interviewerCalls++;
    throw new LlmApiError('OpenAI', 429, '{"error":{"code":"insufficient_quota"}}');
  }
}

const C1: Competency = {
  id: 'c1', name: 'Stakeholder Management', definition: 'Keeps partners aligned on delivery.', category: 'behavioral',
  classification: 'essential', weight: 1, requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: [],
};
const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [], competencies: [C1],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};
const signal: DirectorSignal = { nextCompetencyId: 'c1', action: 'ask', depthInstruction: 'hold', timeRemainingMinutes: 20, coverageState: { c1: 0 }, reason: 't' };
const turns: TurnRecord[] = [
  { id: 'a', index: 0, speaker: 'agent', text: 'Tell me about your current role.', startMs: 0, endMs: 1, confidence: 1, competencyId: '__warmup__' },
  { id: 'b', index: 1, speaker: 'candidate', text: 'I run delivery for two product teams.', startMs: 1, endMs: 2, confidence: 1, competencyId: '__warmup__' },
];
const RUNG = 'Tell me about a partner who pushed back on a delivery date you had committed to.';

function plan(withLadder: boolean): InterviewPlan {
  const p = buildInterviewPlan({ role: ROLE, durationMinutes: 30 });
  if (!withLadder) return p;
  return {
    ...p,
    blocks: p.blocks.map((b): PlanBlock => (b.competencyId !== 'c1' ? b : {
      ...b,
      library: {
        source: 'library', competencyKey: 'stakeholder', trial: false, startRung: 0,
        ladder: [RUNG, 'How do you decide which partner to disappoint when two priorities collide?'].map((questionText, i) => ({
          entryId: `e${i}`, standardId: null, questionText, anchors: ['a'], form: 'star', difficultyTag: i + 1,
        })),
      },
    })),
  };
}

const ask = (withLadder = false) => traceServing(() => nextUtterance({ plan: plan(withLadder), signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } }));

let primary: FailingProvider;

beforeEach(() => {
  primary = new FailingProvider();
  _setLlmForTests(primary);
});

afterEach(() => {
  _setLlmForTests(null);
});

describe('both flags off', () => {
  it('has the library off by default', () => {
    expect(config.library.enabled).toBe(false);
  });

  it('has the local fallback off by default', () => {
    expect(config.llm.local.enabled).toBe(false);
  });

  it('stores only kind and question on an agent turn', async () => {
    const { result, served } = await ask();
    expect(Object.keys(agentTurnMeta(result, served)).sort()).toEqual(['kind', 'question']);
  });

  it('records no serving trace when the primary fails', async () => {
    const { served } = await ask();
    expect(served).toEqual([]);
  });

  it('asks the built-in bank, not a stored rung, when the primary fails on a plan that still carries a ladder', async () => {
    const { result } = await ask(true);
    expect({ rung: result.question === RUNG, entry: result.libraryEntryId }).toEqual({ rung: false, entry: undefined });
  });

  it('asks the interviewer model once for a rung turn, never a second time', async () => {
    await ask(true);
    expect(primary.interviewerCalls).toBe(1);
  });
});
