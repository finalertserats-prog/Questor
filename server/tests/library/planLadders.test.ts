import { describe, expect, it } from 'vitest';
import type { FitScore, InterviewPlan, LibraryQuestionSnapshot, PlanBlock } from '../../src/domain/types.js';
import {
  applyLadders, CALLBACK_BLOCK_ID, cvSignalsFor, startRungFor, trialPicks, unavailableLibrary, withCallback, type LadderPlanInput,
} from '../../src/library/planLadders.js';
import { seededRandom } from '../../src/library/sample.js';

/** Library ladders on an interview plan: which blocks draw from the library, the trial split, the callback turn. */

function block(competencyId: string, targetMinutes = 6): PlanBlock {
  return { competencyId, competencyName: competencyId, intent: `intent ${competencyId}`, targetMinutes, followupHints: [], prohibited: ['age'] };
}

function planOf(ids: string[], minutes = 6): InterviewPlan {
  return {
    durationMinutes: 45, language: 'en', modules: [], coverageTargets: {},
    blocks: [block('__process__', 2), block('__warmup__', 4), ...ids.map((id) => block(id, minutes)), block('__resume_validation__', 3), block('__candidate_questions__', 3)],
  };
}

function rung(entryId: string, difficultyTag: number, form: string): LibraryQuestionSnapshot {
  return { entryId, standardId: null, questionText: `Question ${entryId}?`, anchors: [`anchor ${entryId}`], form, difficultyTag };
}

const ladder = (prefix: string) => [rung(`${prefix}1`, 1, 'star'), rung(`${prefix}2`, 2, 'opinion'), rung(`${prefix}3`, 3, 'tradeoff')];

function input(overrides: Partial<LadderPlanInput> = {}): LadderPlanInput {
  return {
    mode: 'on',
    ladders: { 'key-a': ladder('a'), 'key-b': ladder('b'), 'key-c': ladder('c'), 'key-d': ladder('d') },
    competencyKeys: { a: 'key-a', b: 'key-b', c: 'key-c', d: 'key-d' },
    trialPercent: 50, cvSignals: {}, rng: seededRandom(3),
    meta: { rubricVersion: 'sc-1', roleSlug: 'role', band: 'established', windowDays: 30, selectedAt: '2026-09-22T00:00:00.000Z' },
    ...overrides,
  };
}

const competencyBlocks = (plan: InterviewPlan) => plan.blocks.filter((b) => !b.competencyId.startsWith('__'));

describe('applyLadders in mode "on"', () => {
  it('draws every block with a ladder from the library', () => {
    const plan = applyLadders(planOf(['a', 'b']), input());
    expect(competencyBlocks(plan).map((b) => b.library?.source)).toEqual(['library', 'library']);
  });

  it('stores the ladder snapshot on the block', () => {
    const plan = applyLadders(planOf(['a', 'b']), input());
    expect(competencyBlocks(plan)[0].library?.ladder?.map((r) => r.entryId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('falls back to the built-in bank for a block with no ladder', () => {
    const plan = applyLadders(planOf(['a', 'x']), input());
    expect(competencyBlocks(plan)[1].library).toMatchObject({ source: 'builtin', reason: 'no_ladder' });
  });

  it('treats a one-rung ladder as no ladder', () => {
    const plan = applyLadders(planOf(['a', 'b']), input({ ladders: { 'key-a': [rung('a1', 1, 'star')], 'key-b': ladder('b') } }));
    expect(competencyBlocks(plan)[0].library?.source).toBe('builtin');
  });

  it('keeps the planner intent and minutes of every block', () => {
    const plan = applyLadders(planOf(['a', 'b', 'c']), input());
    expect(competencyBlocks(plan).map((b) => b.intent)).toEqual(['intent a', 'intent b', 'intent c']);
  });

  it('records the rubric version and mode on the plan', () => {
    const plan = applyLadders(planOf(['a']), input());
    expect(plan.library).toMatchObject({ mode: 'on', rubricVersion: 'sc-1', windowDays: 30 });
  });

  it('leaves non-competency blocks untouched', () => {
    const plan = applyLadders(planOf(['a']), input());
    expect(plan.blocks.find((b) => b.competencyId === '__warmup__')?.library).toBeUndefined();
  });

  it('does not mutate the plan it was given', () => {
    const original = planOf(['a', 'b']);
    const copy = JSON.stringify(original);
    applyLadders(original, input());
    expect(JSON.stringify(original)).toBe(copy);
  });
});

describe('applyLadders in trial mode', () => {
  it('alternates library and built-in blocks at 50%', () => {
    const plan = applyLadders(planOf(['a', 'b', 'c', 'd']), input({ mode: 'trial' }));
    const sources = competencyBlocks(plan).map((b) => b.library?.source);
    expect(sources.every((s, i) => i === 0 || s !== sources[i - 1])).toBe(true);
  });

  it('marks the built-in side as the trial control', () => {
    const plan = applyLadders(planOf(['a', 'b', 'c', 'd']), input({ mode: 'trial' }));
    const control = competencyBlocks(plan).filter((b) => b.library?.source === 'builtin');
    expect(control.every((b) => b.library?.reason === 'trial_control' && b.library.trial)).toBe(true);
  });

  it('takes half of the eligible blocks from the library', () => {
    const plan = applyLadders(planOf(['a', 'b', 'c', 'd']), input({ mode: 'trial' }));
    expect(competencyBlocks(plan).filter((b) => b.library?.source === 'library').length).toBe(2);
  });

  it('leaves a block with no ladder out of the pairing', () => {
    const plan = applyLadders(planOf(['a', 'x', 'b']), input({ mode: 'trial' }));
    expect(competencyBlocks(plan)[1].library).toMatchObject({ source: 'builtin', reason: 'no_ladder', trial: false });
  });

  it('records the trial percent on the plan', () => {
    expect(applyLadders(planOf(['a']), input({ mode: 'trial', trialPercent: 10 })).library?.trialPercent).toBe(10);
  });

  it('draws nothing from the library at 0%', () => {
    const plan = applyLadders(planOf(['a', 'b', 'c']), input({ mode: 'trial', trialPercent: 0 }));
    expect(competencyBlocks(plan).some((b) => b.library?.source === 'library')).toBe(false);
  });

  it('draws everything from the library at 100%', () => {
    const plan = applyLadders(planOf(['a', 'b', 'c']), input({ mode: 'trial', trialPercent: 100 }));
    expect(competencyBlocks(plan).every((b) => b.library?.source === 'library')).toBe(true);
  });
});

describe('trialPicks', () => {
  it('picks about the requested share over many interviews', () => {
    const rng = seededRandom(11);
    let picked = 0;
    for (let i = 0; i < 400; i++) picked += trialPicks(5, 10, rng).filter(Boolean).length;
    expect(Math.abs(picked / 2000 - 0.1)).toBeLessThan(0.02);
  });

  it('starts on either side across interviews', () => {
    const rng = seededRandom(5);
    const firsts = new Set(Array.from({ length: 40 }, () => trialPicks(4, 50, rng)[0]));
    expect(firsts.size).toBe(2);
  });
});

describe('startRungFor', () => {
  it('starts in the middle of a three-rung ladder', () => {
    expect(startRungFor(3)).toBe(1);
  });

  it('starts one rung up for a strong CV', () => {
    expect(startRungFor(3, 'strong')).toBe(2);
  });

  it('starts one rung down for a thin CV', () => {
    expect(startRungFor(3, 'thin')).toBe(0);
  });

  it('starts on the easier rung of a two-rung ladder', () => {
    expect(startRungFor(2)).toBe(0);
  });

  it('applies the CV signal to the block', () => {
    const plan = applyLadders(planOf(['a', 'b']), input({ cvSignals: { a: 'strong' } }));
    expect(competencyBlocks(plan)[0].library).toMatchObject({ startRung: 2, cvSignal: 'strong' });
  });
});

describe('the callback turn', () => {
  it('follows the second competency block', () => {
    const plan = applyLadders(planOf(['a', 'b', 'c']), input());
    const ids = plan.blocks.map((b) => b.competencyId);
    expect(ids.indexOf(CALLBACK_BLOCK_ID)).toBe(ids.indexOf('b') + 1);
  });

  it('is left out of an interview with one competency', () => {
    const plan = applyLadders(planOf(['a']), input());
    expect(plan.blocks.some((b) => b.competencyId === CALLBACK_BLOCK_ID)).toBe(false);
  });

  it('takes its minutes from the competency blocks, so the plan does not grow', () => {
    const before = planOf(['a', 'b', 'c']);
    const after = applyLadders(before, input());
    const total = (p: InterviewPlan) => p.blocks.reduce((sum, b) => sum + b.targetMinutes, 0);
    expect(total(after)).toBe(total(before));
  });

  it('is left out when no block can spare the minutes', () => {
    const plan = withCallback(planOf(['a', 'b'], 2).blocks);
    expect(plan.some((b) => b.competencyId === CALLBACK_BLOCK_ID)).toBe(false);
  });

  it('is added once however often the plan is annotated', () => {
    const plan = withCallback(withCallback(planOf(['a', 'b', 'c']).blocks));
    expect(plan.filter((b) => b.competencyId === CALLBACK_BLOCK_ID).length).toBe(1);
  });
});

describe('unavailableLibrary', () => {
  it('marks every competency block built-in with the reason', () => {
    const plan = unavailableLibrary(planOf(['a', 'b']), 'on', input().meta, 'select_failed', { a: 'key-a', b: 'key-b' });
    expect(competencyBlocks(plan).every((b) => b.library?.source === 'builtin' && b.library.reason === 'select_failed')).toBe(true);
  });

  it('says why on the plan', () => {
    expect(unavailableLibrary(planOf(['a']), 'trial', input().meta, 'role_not_in_catalog', {}).library?.unavailable).toBe('role_not_in_catalog');
  });
});

describe('cvSignalsFor', () => {
  const fit: FitScore = {
    overall: 60, confidence: 0.6, excludedSignals: [], probes: [],
    missing: ['Stakeholder Management'],
    components: [
      { key: 'essential', label: '', weight: 0.35, score: 80, rule: '', evidence: ['Led incident response for payments outages', 'Wrote incident postmortems within a day'] },
      { key: 'technical', label: '', weight: 0.2, score: 60, evidence: ['Designed a ledger schema'], rule: '' },
    ],
  };
  const competencies = [{ id: 'c1', name: 'Incident Response' }, { id: 'c2', name: 'Stakeholder Management' }, { id: 'c3', name: 'Ledger Design' }];

  it('reads a competency the CV names twice as strong', () => {
    expect(cvSignalsFor(fit, competencies).c1).toBe('strong');
  });

  it('reads a competency the CV never names as thin', () => {
    expect(cvSignalsFor(fit, competencies).c2).toBe('thin');
  });

  it('reads a single mention as neutral', () => {
    expect(cvSignalsFor(fit, competencies).c3).toBe('neutral');
  });

  it('says nothing without a fit score', () => {
    expect(cvSignalsFor(undefined, competencies)).toEqual({});
  });
});
