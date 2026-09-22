import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmApiError, type LlmGenerateOptions, type LlmMessage, type LlmProvider, type LlmResult } from '../src/providers/llm/types.js';
import type { Competency, DirectorSignal, PlanBlock, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

/**
 * On the local model the interviewer keeps its substance: the question comes
 * from the plan (the library ladder when there is one, otherwise the built-in
 * writer's own question), and the local model only writes the spoken glue
 * around it, in the same persona prompt, checked before it is said.
 */

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return {
    config: {
      ...actual.config,
      llm: {
        ...actual.config.llm,
        local: {
          enabled: true, url: 'http://127.0.0.1:11434', model: 'llama3.2:3b', timeoutMs: 12_000, firstTokenMs: 8_000, keepAlive: '24h',
          outageCooldownMs: 300_000, transientCooldownMs: 30_000, maxCooldownMs: 900_000, slowCallMs: 60_000,
        },
      },
    },
  };
});
vi.mock('../src/providers/email/index.js', () => ({ getEmail: () => ({ name: 'fake', configured: true, delivers: false, send: async () => ({ status: 'logged', id: 'x' }) }) }));

const { _setLlmForTests, _setLocalLlmForTests } = await import('../src/providers/llm/index.js');
const { _resetServingState } = await import('../src/providers/llm/serving.js');
const { nextUtterance } = await import('../src/engines/conversationRuntime.js');
const { buildInterviewPlan } = await import('../src/engines/interviewPlanner.js');

class Fake implements LlmProvider {
  calls: Array<{ messages: LlmMessage[]; opts?: LlmGenerateOptions }> = [];
  constructor(public name: string, private replies: Array<string | Error>, public enabled = true) {}
  async generate(messages: LlmMessage[], opts?: LlmGenerateOptions): Promise<LlmResult> {
    this.calls.push({ messages, opts });
    const next = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
    if (next instanceof Error) throw next;
    return { text: next, model: `${this.name}-m`, inputTokens: 0, outputTokens: 0, latencyMs: 1 };
  }
}

const QUOTA = new LlmApiError('OpenAI', 429, '{"error":{"code":"insufficient_quota"}}');

const SURVEY: Competency = {
  id: 'c_survey', name: 'Survey Programming', definition: 'Scripting questionnaires in Decipher and Qualtrics.', category: 'technical',
  classification: 'essential', weight: 1, requiredLevel: 2, targetLevel: 4, indicators: [], evidenceModes: [],
};
const ROLE: RoleSuccessProfile = {
  roleContext: '', outcomes: [], responsibilities: ['Script and test survey questionnaires'], competencies: [SURVEY],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'Mid',
};
const signal: DirectorSignal = { nextCompetencyId: SURVEY.id, action: 'ask', depthInstruction: 'hold', timeRemainingMinutes: 20, coverageState: { [SURVEY.id]: 0 }, reason: 't' };
const ANSWER = 'I program surveys in Decipher for three research teams.';
const turns: TurnRecord[] = [
  { id: 'a', index: 0, speaker: 'agent', text: 'Tell me about your current role.', startMs: 0, endMs: 1, confidence: 1, competencyId: '__warmup__' },
  { id: 'b', index: 1, speaker: 'candidate', text: ANSWER, startMs: 1, endMs: 2, confidence: 1, competencyId: '__warmup__' },
];
const LADDER = ['Walk me through the last questionnaire you scripted from brief to launch.', 'How do you test skip logic before a survey goes live?'];

function plan(withLadder = false) {
  const p = buildInterviewPlan({ role: ROLE, durationMinutes: 30 });
  if (!withLadder) return p;
  return {
    ...p,
    blocks: p.blocks.map((b): PlanBlock => (b.competencyId !== SURVEY.id ? b : {
      ...b,
      library: {
        source: 'library', competencyKey: 'survey', trial: false, startRung: 0,
        ladder: LADDER.map((questionText, i) => ({ entryId: `e${i}`, standardId: null, questionText, anchors: ['never said aloud'], form: 'walkthrough', difficultyTag: i + 1 })),
      },
    } as PlanBlock)),
  };
}

const ask = (withLadder = false) => nextUtterance({ plan: plan(withLadder), signal, turns, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });

const GOOD_GLUE = '{"acknowledgement":"So you program surveys in Decipher for three research teams.","probe":0}';

let primary: Fake;

beforeEach(() => {
  _resetServingState();
  primary = new Fake('openai', [QUOTA]);
  _setLlmForTests(primary);
});

afterEach(() => {
  _setLlmForTests(null);
  _setLocalLlmForTests(null);
});

async function builtInBaseline(withLadder = false) {
  _setLocalLlmForTests(new Fake('ollama', [new TypeError('fetch failed')]));
  const u = await ask(withLadder);
  _resetServingState();
  return u;
}

describe('the interviewer on the local model', () => {
  it('asks the built-in writer\'s own question, not one the local model wrote', async () => {
    const baseline = await builtInBaseline();
    _setLocalLlmForTests(new Fake('ollama', ['{"acknowledgement":"So you program surveys in Decipher for three research teams.","question":"Invented question?"}']));
    const u = await ask();
    expect(u.question).toBe(baseline.question);
  });

  it('speaks the local model\'s acknowledgement before the planned question', async () => {
    _setLocalLlmForTests(new Fake('ollama', [GOOD_GLUE]));
    const u = await ask();
    expect(u.text.startsWith('So you program surveys in Decipher for three research teams.')).toBe(true);
  });

  it('keeps the interviewer persona prompt, so the style does not shift at the switch', async () => {
    const local = new Fake('ollama', [GOOD_GLUE]);
    _setLocalLlmForTests(local);
    // A primary that answers, so its interviewer prompt can be compared.
    const seen = new Fake('openai', ['{"acknowledgement":"","question":"Walk me through a recent survey you scripted."}']);
    _setLlmForTests(seen);
    await ask();
    _resetServingState();
    _setLlmForTests(new Fake('openai', [QUOTA]));
    await ask();
    const primarySystem = seen.calls.find((c) => c.messages[0].content.includes('AI interviewer'))!.messages[0].content;
    expect(local.calls[0].messages[0].content.startsWith(primarySystem)).toBe(true);
  });

  it('asks from the plan\'s library ladder when there is one', async () => {
    _setLocalLlmForTests(new Fake('ollama', [GOOD_GLUE]));
    const u = await ask(true);
    expect(u.question).toBe(LADDER[0]);
  });

  it('lets the local model pick which planned probe fits', async () => {
    _setLocalLlmForTests(new Fake('ollama', ['{"acknowledgement":"So you program surveys in Decipher.","probe":1}']));
    const u = await ask(true);
    expect(u.question).toBe(LADDER[1]);
  });

  it('shows the local model the planned questions but never the anchors', async () => {
    const local = new Fake('ollama', [GOOD_GLUE]);
    _setLocalLlmForTests(local);
    await ask(true);
    const sent = local.calls[0].messages.map((m) => m.content).join('\n');
    expect([sent.includes(LADDER[1]), sent.includes('never said aloud')]).toEqual([true, false]);
  });

  it('retries once when the glue fails the check, then uses the built-in turn', async () => {
    const baseline = await builtInBaseline();
    const local = new Fake('ollama', ['{"acknowledgement":"Why Decipher?"}']);
    _setLocalLlmForTests(local);
    const u = await ask();
    expect([local.calls.length, u.text]).toEqual([2, baseline.text]);
  });

  it('uses a retry that passes the check', async () => {
    _setLocalLlmForTests(new Fake('ollama', ['{"acknowledgement":"Great answer!"}', GOOD_GLUE]));
    const u = await ask();
    expect(u.text.startsWith('So you program surveys in Decipher')).toBe(true);
  });

  it('refuses glue that invents a detail the candidate never gave', async () => {
    const baseline = await builtInBaseline();
    _setLocalLlmForTests(new Fake('ollama', ['{"acknowledgement":"So you program surveys in Qualtrics for five teams."}']));
    const u = await ask();
    expect(u.text).toBe(baseline.text);
  });
});

describe('the built-in writer with a planned ladder', () => {
  it('asks the ladder\'s question when every model is unavailable', async () => {
    _setLocalLlmForTests(new Fake('ollama', [new TypeError('fetch failed')]));
    const u = await ask(true);
    expect(u.question).toBe(LADDER[0]);
  });
});

describe('candidate questions on the local model', () => {
  const asked: TurnRecord[] = [
    ...turns,
    { id: 'q', index: 2, speaker: 'agent', text: 'Walk me through a survey you scripted.', startMs: 2, endMs: 3, confidence: 1, competencyId: SURVEY.id, kind: 'question' },
    { id: 'c', index: 3, speaker: 'candidate', text: 'Before I answer, what is the salary for this role?', startMs: 3, endMs: 4, confidence: 1, competencyId: SURVEY.id },
  ];
  const askQuestion = () => nextUtterance({ plan: plan(), signal, turns: asked, role: ROLE, persona: { name: 'Maya', tone: 'warm' } });

  it('refuses an answer that states a figure the role facts do not hold', async () => {
    _setLocalLlmForTests(new Fake('ollama', ['{"answer":"The salary is 50000 a year."}']));
    const u = await askQuestion();
    expect(u.text).not.toContain('50000');
  });

  it('speaks a grounded local answer', async () => {
    _setLocalLlmForTests(new Fake('ollama', ['{"answer":"I do not have that detail; the hiring team will cover it when they follow up."}']));
    const u = await askQuestion();
    expect(u.text).toContain('the hiring team will cover it');
  });
});
