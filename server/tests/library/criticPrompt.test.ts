import { describe, expect, it } from 'vitest';
import { ANSWER_LEAK_EXAMPLES, buildCriticPrompt, CRITIC_PROMPT_VERSION } from '../../src/library/critic.js';
import type { PoolContext } from '../../src/library/generator.js';

/**
 * The critic rubric, shared by the server worker and the offline seed run.
 * "Answer leaked" (owner decision 2026-09-22) means the QUESTION gives the
 * answer away; asking about the competency's own topic is not a leak.
 */

const ctx: PoolContext = {
  pool: { scope: 'global', tenantId: null, roleSlug: 'enterprise-account-executive', familySlug: 'professional-operations', competencyKey: 'negotiation', band: 'senior' },
  roleTitle: 'Enterprise Account Executive', familyName: 'Professional / Operations',
  competency: { name: 'Negotiation', definition: 'Negotiates price and terms.', indicators: ['Trades concessions for commitments'], category: 'domain' },
  band: 'senior', jdText: 'Shared catalog text.', existingQuestions: [],
};

const system = buildCriticPrompt(ctx, [{ questionText: 'Tell me about a hard negotiation?', form: 'star', difficultyTag: 2, rationale: '' }], ['Trades each concession for a commitment']).system;

describe('the answer-leak rule', () => {
  it('is a new critic prompt version', () => {
    expect(CRITIC_PROMPT_VERSION).toBe('library-critic-v2');
  });

  it('asks whether the question gives the answer away', () => {
    expect(system).toMatch(/anchorsLeaked — does the question give the answer away/);
  });

  it('says that asking about the competency\'s own topic is not a leak', () => {
    expect(system).toMatch(/own topic[^.]*is NOT a leak/);
  });

  it('carries calibration examples on both sides of the line', () => {
    expect(new Set(ANSWER_LEAK_EXAMPLES.map((e) => e.leaked))).toEqual(new Set([true, false]));
  });

  it.each(ANSWER_LEAK_EXAMPLES.filter((e) => e.leaked).map((e) => [e.question] as const))('shows as a leak: %s', (question) => {
    expect(system).toContain(`LEAK: "${question}"`);
  });

  it.each(ANSWER_LEAK_EXAMPLES.filter((e) => !e.leaked).map((e) => [e.question] as const))('shows as not a leak: %s', (question) => {
    expect(system).toContain(`NOT A LEAK: "${question}"`);
  });

  it('pairs each leak with a fair question on the same topic and anchors', () => {
    const topics = (leaked: boolean) => new Set(ANSWER_LEAK_EXAMPLES.filter((e) => e.leaked === leaked).map((e) => e.anchors.join('|')));
    expect(topics(true)).toEqual(topics(false));
  });
});
