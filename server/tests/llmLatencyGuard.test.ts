import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmGenerateOptions, LlmMessage, LlmProvider, LlmResult } from '../src/providers/llm/types.js';

// A voice interview cannot wait on a slow model. The interviewer's call is
// capped (INTERVIEWER_LLM_TIMEOUT_MS, 12s by default; 1s here to keep the test
// quick) and the built-in question is used when the cap is hit — the candidate
// hears a question, never silence.
vi.hoisted(() => { process.env.INTERVIEWER_LLM_TIMEOUT_MS = '1000'; });

const { generateJson, _setLlmForTests } = await import('../src/providers/llm/index.js');
const { nextUtterance } = await import('../src/engines/conversationRuntime.js');
const { buildInterviewPlan } = await import('../src/engines/interviewPlanner.js');
const { evaluate } = await import('../src/engines/evaluator.js');
import type { Competency, DirectorSignal, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

class FakeProvider implements LlmProvider {
  name = 'fake';
  enabled = true;
  calls: Array<{ system: string; opts?: LlmGenerateOptions }> = [];
  constructor(private delayMs: number, private text = '{"question":"What did you do next?"}') {}
  async generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult> {
    this.calls.push({ system: messages.find((m) => m.role === 'system')?.content ?? '', opts });
    await new Promise((r) => setTimeout(r, this.delayMs));
    return { text: this.text, model: 'fake', inputTokens: 0, outputTokens: 0, latencyMs: this.delayMs };
  }
}

afterEach(() => _setLlmForTests(null));

const SURVEY: Competency = {
  id: 'c_survey', name: 'Survey Programming', definition: 'Scripting questionnaires in Decipher and Qualtrics.', category: 'technical',
  classification: 'essential', weight: 1, requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: [],
};
const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: [], competencies: [SURVEY],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};
const signal: DirectorSignal = { nextCompetencyId: SURVEY.id, action: 'ask', depthInstruction: 'hold', timeRemainingMinutes: 20, coverageState: { [SURVEY.id]: 0 }, reason: 't' };
const turns: TurnRecord[] = [
  { id: 'a', index: 0, speaker: 'agent', text: 'Tell me about your current role.', startMs: 0, endMs: 1, confidence: 1, competencyId: '__warmup__' },
  { id: 'b', index: 1, speaker: 'candidate', text: 'I program surveys in Decipher for three research teams.', startMs: 1, endMs: 2, confidence: 1, competencyId: '__warmup__' },
];

describe('model call latency guard', () => {
  it('gives up on a slow model at the timeout and returns null for the fallback', async () => {
    _setLlmForTests(new FakeProvider(5_000));
    const started = Date.now();
    const out = await generateJson({ fn: 't', system: 's', user: 'u', validate: (r) => r, timeoutMs: 100 });
    expect(out).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('asks the next question from the built-in bank when the interviewer model is too slow', async () => {
    const slow = new FakeProvider(10_000);
    _setLlmForTests(slow);
    const started = Date.now();
    const u = await nextUtterance({ plan: buildInterviewPlan({ role: ROLE, durationMinutes: 30 }), signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(u.text).toMatch(/Survey Programming/);
  });

  it('passes the interviewer timeout to the provider', async () => {
    const fast = new FakeProvider(1);
    _setLlmForTests(fast);
    await nextUtterance({ plan: buildInterviewPlan({ role: ROLE, durationMinutes: 30 }), signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });
    const interviewer = fast.calls.find((c) => c.system.includes('AI interviewer'));
    expect(interviewer?.opts?.timeoutMs).toBe(1000);
  });

  it('asks for more reasoning when grading than when interviewing', async () => {
    const fake = new FakeProvider(1, '{"level":3,"confidence":0.7,"notEnoughEvidence":false,"rationale":"Specific example."}');
    _setLlmForTests(fake);
    await evaluate({
      role: ROLE, rubricVersion: 'r', assessmentVersion: 'a',
      turns: [
        { id: 'q', index: 0, speaker: 'agent', text: 'Walk me through a survey you scripted.', startMs: 0, endMs: 1, confidence: 1, competencyId: SURVEY.id },
        { id: 'r', index: 1, speaker: 'candidate', text: 'I scripted a 12-market tracker in Decipher with quota logic and tested every skip.', startMs: 1, endMs: 2, confidence: 1, competencyId: SURVEY.id },
      ],
    });
    const grader = fake.calls.find((c) => c.system.includes('independent evaluator'));
    expect(grader?.opts?.reasoningEffort).toBe('medium');
  });
});
