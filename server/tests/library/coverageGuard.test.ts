import { describe, expect, it } from 'vitest';
import type { InterviewPlan, PlanBlock, TurnRecord } from '../../src/domain/types.js';
import { guardedQuota, MAX_PROBES, minutesSpentIn } from '../../src/engines/coverageGuard.js';
import { directorDecide } from '../../src/engines/interviewDirector.js';

/** The coverage guard: library-planned interviews cap probes and keep time for later competencies. */

function block(competencyId: string, targetMinutes: number): PlanBlock {
  return { competencyId, competencyName: competencyId, intent: '', targetMinutes, followupHints: [], prohibited: [] };
}

function plan(library: boolean, duration = 30): InterviewPlan {
  return {
    durationMinutes: duration, language: 'en', modules: [], coverageTargets: {},
    blocks: [block('c1', 6), block('c2', 6), block('c3', 6), block('__candidate_questions__', 3)],
    ...(library ? { library: { mode: 'on' as const, rubricVersion: 's', roleSlug: 'r', band: 'senior', windowDays: 30, selectedAt: '' } } : {}),
  };
}

function turn(speaker: 'agent' | 'candidate', competencyId: string, startMin: number, endMin: number, text = 'During the migration project I led the team and we reduced failures by 40 percent overall.'): TurnRecord {
  return { id: `${speaker}${startMin}`, index: startMin, speaker, text, startMs: startMin * 60_000, endMs: endMin * 60_000, confidence: 1, competencyId, kind: speaker === 'agent' ? 'question' : undefined };
}

describe('guardedQuota', () => {
  it('changes nothing for a plan without the library', () => {
    const p = plan(false);
    expect(guardedQuota({ plan: p, block: p.blocks[0], quota: 5, coverage: { c1: 1 }, turns: [], elapsedMinutes: 29 })).toBe(5);
  });

  it('caps follow-ups on a library-planned block', () => {
    const p = plan(true);
    expect(guardedQuota({ plan: p, block: p.blocks[0], quota: 5, coverage: { c1: 0 }, turns: [], elapsedMinutes: 0 })).toBe(1 + MAX_PROBES);
  });

  it('closes an answered block that has run past its minutes', () => {
    const p = plan(true, 60);
    const turns = [turn('agent', 'c1', 0, 1), turn('candidate', 'c1', 1, 8)];
    expect(guardedQuota({ plan: p, block: p.blocks[0], quota: 3, coverage: { c1: 1 }, turns, elapsedMinutes: 8 })).toBe(1);
  });

  it('closes an answered block when later blocks need the time left', () => {
    const p = plan(true, 12);
    const turns = [turn('agent', 'c1', 0, 1), turn('candidate', 'c1', 1, 3)];
    expect(guardedQuota({ plan: p, block: p.blocks[0], quota: 3, coverage: { c1: 1 }, turns, elapsedMinutes: 5 })).toBe(1);
  });

  it('never closes a block before its first answer', () => {
    const p = plan(true, 12);
    expect(guardedQuota({ plan: p, block: p.blocks[0], quota: 3, coverage: { c1: 0 }, turns: [], elapsedMinutes: 11 })).toBe(3);
  });

  it('measures minutes on the clock between the first and last turn of the block', () => {
    expect(minutesSpentIn('c1', [turn('agent', 'c1', 2, 3), turn('candidate', 'c1', 3, 7)])).toBe(5);
  });
});

describe('the director with the guard', () => {
  it('moves on from a block a long early answer overran, in a library-planned interview', () => {
    const turns = [turn('agent', 'c1', 0, 1), turn('candidate', 'c1', 1, 9)];
    expect(directorDecide({ plan: plan(true, 60), turns, elapsedMinutes: 9 }).nextCompetencyId).toBe('c2');
  });

  it('keeps probing the same overrun block when the library did not plan the interview', () => {
    const turns = [turn('agent', 'c1', 0, 1), turn('candidate', 'c1', 1, 9)];
    expect(directorDecide({ plan: plan(false, 60), turns, elapsedMinutes: 9 }).nextCompetencyId).toBe('c1');
  });
});
