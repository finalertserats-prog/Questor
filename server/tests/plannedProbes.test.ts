import { describe, expect, it } from 'vitest';
import { plannedLadder, unaskedRungs } from '../src/engines/plannedProbes.js';
import type { PlanBlock } from '../src/domain/types.js';

/**
 * When the Q&A library planned a block, its ladder of approved questions is
 * stored on the plan (block.library.ladder). The fallback writers ask from it.
 * A plan without it (library off, or planned before it existed) reads as an
 * empty ladder, and everything behaves as before.
 */

const base: PlanBlock = { competencyId: 'c1', competencyName: 'Stakeholder management', intent: 'x', targetMinutes: 5, followupHints: [], prohibited: [] };

function withLadder(texts: string[], startRung?: number, source: 'library' | 'builtin' = 'library'): PlanBlock {
  return {
    ...base,
    library: {
      source, competencyKey: 'k', trial: false, startRung,
      ladder: texts.map((questionText, i) => ({ entryId: `e${i}`, standardId: null, questionText, anchors: ['secret anchor'], form: 'behavioural', difficultyTag: i + 1 })),
    },
  } as unknown as PlanBlock;
}

describe('plannedLadder', () => {
  it('is empty for a block the library did not plan', () => {
    expect(plannedLadder(base)).toEqual([]);
  });

  it('is empty for an undefined block', () => {
    expect(plannedLadder(undefined)).toEqual([]);
  });

  it('is empty when the library fell back to the built-in bank for the block', () => {
    expect(plannedLadder(withLadder(['Q1'], 0, 'builtin'))).toEqual([]);
  });

  it('starts at the planned rung and climbs, then comes back down', () => {
    expect(plannedLadder(withLadder(['easy', 'middle', 'hard'], 1))).toEqual(['middle', 'hard', 'easy']);
  });

  it('starts at the middle rung when no start is stored', () => {
    expect(plannedLadder(withLadder(['easy', 'middle', 'hard']))).toEqual(['middle', 'hard', 'easy']);
  });

  it('ignores a malformed ladder rather than throwing', () => {
    expect(plannedLadder({ ...base, library: { source: 'library', ladder: [{ questionText: 7 }] } } as unknown as PlanBlock)).toEqual([]);
  });

  it('never exposes the anchors', () => {
    expect(JSON.stringify(plannedLadder(withLadder(['Q1', 'Q2'])))).not.toContain('secret anchor');
  });
});

describe('unaskedRungs', () => {
  it('drops a rung already asked, ignoring case and spacing', () => {
    const block = withLadder(['Tell me about a hard stakeholder.', 'How did you handle pushback?'], 0);
    expect(unaskedRungs(block, ['tell me about  a hard stakeholder.'])).toEqual(['How did you handle pushback?']);
  });

  it('finds a rung asked inside a longer turn with a lead-in', () => {
    const block = withLadder(['How did you handle pushback?'], 0);
    expect(unaskedRungs(block, ['Thanks. How did you handle pushback?'])).toEqual([]);
  });
});
