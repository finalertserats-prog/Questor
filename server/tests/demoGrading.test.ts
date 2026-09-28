import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Competency, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

/**
 * A demo interview never spends on a paid model, so the model layer answers
 * null for it. With a provider configured, the evaluator read that null as a
 * grading outage and withheld every score — so in production the demo report
 * showed nothing at all. A demo must take the built-in heuristic grader.
 */

const generate = vi.fn(async () => ({ text: '{}' }));

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, llm: { ...actual.config.llm, provider: 'anthropic', anthropicKey: 'test-key' } } };
});

vi.mock('../src/providers/llm/anthropic.js', () => ({
  AnthropicLlmProvider: class {
    name = 'anthropic';
    get enabled(): boolean { return true; }
    generate = generate;
  },
}));

const { evaluate } = await import('../src/engines/evaluator.js');
const { _resetLlm } = await import('../src/providers/llm/index.js');
const { prisma } = await import('../src/db.js');
const { wipe } = await import('../src/seed/demoData.js');
const { provisionDemoTenant } = await import('../src/services/demoAccess.js');

const PIPELINES: Competency = {
  id: 'pipelines', name: 'Pipeline reliability', definition: 'Demonstrates pipeline reliability.', category: 'technical', classification: 'essential',
  weight: 1, requiredLevel: 3, targetLevel: 4, indicators: ['shows pipeline reliability'], evidenceModes: ['behavioral_example'],
};

const ROLE: RoleSuccessProfile = {
  roleContext: 'Senior Data Engineer', outcomes: [], responsibilities: [], competencies: [PIPELINES],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [], seniority: 'senior',
};

const ANSWER: TurnRecord = {
  id: 'turn-1', index: 0, speaker: 'candidate', startMs: 0, endMs: 30_000, confidence: 0.9, competencyId: 'pipelines',
  text: 'I owned the ledger pipeline end to end. When reconciliation drift appeared I built an idempotent replay so a failed run could be re-driven safely, and unmatched rows fell from two thousand a day to under thirty.',
};

async function demoSessionId(): Promise<string> {
  await wipe();
  await prisma.demoGrant.deleteMany();
  return (await provisionDemoTenant({ name: 'Asha', email: 'asha@acme.test', company: 'Acme' })).sessionId;
}

beforeEach(() => { _resetLlm(); generate.mockClear(); });

describe('grading a demo interview with a model provider configured', () => {
  it('produces heuristic scores instead of withholding them', async () => {
    const sessionId = await demoSessionId();

    const result = await evaluate({ role: ROLE, turns: [ANSWER], rubricVersion: 'v1', assessmentVersion: 'A-1', sessionId });

    expect(result.competencies.some((c) => c.gradingUnavailable)).toBe(false);
  });

  it('never calls the model', async () => {
    const sessionId = await demoSessionId();

    await evaluate({ role: ROLE, turns: [ANSWER], rubricVersion: 'v1', assessmentVersion: 'A-1', sessionId });

    expect(generate).not.toHaveBeenCalled();
  });
});
