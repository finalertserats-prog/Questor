import { describe, expect, it } from 'vitest';
import {
  budgetBurn, compactTokens, decisionMessage, depthLabel, formMixLabel, gateLabel, healthTone, humanSlug, sortPools, stratumLabel,
  verdictProblems, workerAdvice, workerStateLabel, workerStateTone, type PoolRow,
} from '../src/components/library/libraryAdminModel';

/** The owner's library screen: how the API's numbers and states read on the page. */

const pool = (over: Partial<PoolRow>): PoolRow => ({
  roleSlug: 'payments-platform-engineer', competencyKey: 'incident-ownership', band: 'established', target: 12, live: 0, probational: 0, queued: 0,
  rejected: 0, retired: 0, health: 'empty', formMix: {}, formMixOk: false, ...over,
});

describe('worker state', () => {
  it('names waiting for credits plainly', () => {
    expect(workerStateLabel('waiting_for_credits')).toBe('Waiting for credits');
  });

  it('treats a missing critic as a stop', () => {
    expect(workerStateTone('critic_unavailable')).toBe('stop');
  });

  it('tells the owner which key the Anthropic critic needs', () => {
    const advice = workerAdvice({ workerEnabled: true, critic: { provider: 'anthropic', model: 'claude-sonnet-5', configured: false }, worker: { state: 'stopped', reason: '', since: '', lastBatchAt: null, lastError: '' } });
    expect(advice).toContain('ANTHROPIC_API_KEY');
  });

  it('says nothing when the worker can run', () => {
    expect(workerAdvice({ workerEnabled: true, critic: { provider: 'anthropic', model: 'x', configured: true }, worker: { state: 'running', reason: '', since: '', lastBatchAt: null, lastError: '' } })).toBe('');
  });

  it('explains a switched-off worker', () => {
    expect(workerAdvice({ workerEnabled: false, critic: { provider: 'anthropic', model: 'x', configured: true }, worker: { state: 'stopped', reason: '', since: '', lastBatchAt: null, lastError: '' } })).toContain('LIBRARY_WORKER_ENABLED');
  });
});

describe('budget', () => {
  it('reports the day\'s share of calls', () => {
    expect(budgetBurn({ day: '2026-09-20', callsUsedToday: 750, dailyCap: 3000, tokens30d: 0, monthlyCap: 100, tokensToday: 0 }).dailyShare).toBe(0.25);
  });

  it('never reports more than the whole cap', () => {
    expect(budgetBurn({ day: '2026-09-20', callsUsedToday: 5000, dailyCap: 3000, tokens30d: 0, monthlyCap: 100, tokensToday: 0 }).dailyShare).toBe(1);
  });

  it('writes millions compactly', () => {
    expect(compactTokens(80_000_000)).toBe('80M');
  });
});

describe('pools', () => {
  it('puts empty pools before thin ones', () => {
    const sorted = sortPools([pool({ health: 'ready', live: 12 }), pool({ health: 'empty', competencyKey: 'a' }), pool({ health: 'thin', live: 3, competencyKey: 'b' })]);
    expect(sorted.map((p) => p.health)).toEqual(['empty', 'thin', 'ready']);
  });

  it('marks a thin pool as a warning', () => {
    expect(healthTone('thin')).toBe('warn');
  });

  it('reads depth against target', () => {
    expect(depthLabel({ live: 4, probational: 2, target: 12 })).toBe('4 live · 2 probational · target 12');
  });

  it('lists the form mix largest first', () => {
    expect(formMixLabel({ star: 2, work_sample: 4, opinion: 3 })).toBe('work sample 4 · opinion 3 · star 2');
  });

  it('turns a slug into a title', () => {
    expect(humanSlug('payments-platform-engineer')).toBe('Payments Platform Engineer');
  });

  it('reads a stratum key', () => {
    expect(stratumLabel('global|payments-platform-engineer|established|work_sample|library-gen-v1')).toBe('Payments Platform Engineer · established · work sample · library-gen-v1');
  });
});

describe('entries', () => {
  it('explains why an entry waits in the queue', () => {
    expect(gateLabel({ status: 'draft', gateOutcome: 'unsure', gateReasons: ['stratum:new', 'lint:reading_level'] })).toBe('Needs a look: stratum:new, lint:reading_level');
  });

  it('lists the critic\'s failed checks', () => {
    expect(verdictProblems({ realQuestion: true, rightBand: true, answerable: true, formCorrect: true, anchorsLeaked: false, roleSpecific: false, confidence: 0.4, notes: '' })).toEqual(['generic, not role-specific']);
  });

  it('says when there is no verdict', () => {
    expect(verdictProblems(null)).toEqual(['no critic verdict']);
  });

  it('tells the owner to reload after a lost race', () => {
    expect(decisionMessage('approve', false, 'invalid_transition')).toContain('Reload');
  });
});
