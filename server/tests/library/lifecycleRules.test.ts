import { describe, expect, it } from 'vitest';
import { assertEntryId, canTransition, promotionDecision } from '../../src/library/lifecycle.js';
import { DEFAULT_POLICY, isReservedEntryId } from '../../src/library/types.js';

/** Status transitions are forward-only; nothing is ever deleted. */

describe('canTransition', () => {
  it('lets a draft become probational', () => {
    expect(canTransition('draft', 'probational')).toBe(true);
  });

  it('lets a probational entry go live', () => {
    expect(canTransition('probational', 'live')).toBe(true);
  });

  it('never lets a live entry fall back to probational', () => {
    expect(canTransition('live', 'probational')).toBe(false);
  });

  it('never revives a rejected entry', () => {
    expect(canTransition('rejected', 'draft')).toBe(false);
  });

  it('never revives a retired entry', () => {
    expect(canTransition('retired', 'live')).toBe(false);
  });

  it('lets a live entry retire', () => {
    expect(canTransition('live', 'retired')).toBe(true);
  });
});

describe('reserved ids', () => {
  it('reserves the engine\'s double-underscore namespace', () => {
    expect(isReservedEntryId('__resume_validation__')).toBe(true);
  });

  it('accepts an ordinary id', () => {
    expect(isReservedEntryId('ckx1abc')).toBe(false);
  });

  it('throws on a reserved id', () => {
    expect(() => assertEntryId('__opening__')).toThrow(/reserved/);
  });
});

describe('promotionDecision', () => {
  const uses = (n: number, outcome = 'answered') => Array.from({ length: n }, () => ({ outcome }));

  it('promotes after the policy\'s clean uses', () => {
    expect(promotionDecision({ uses: uses(5), policy: DEFAULT_POLICY }).promote).toBe(true);
  });

  it('waits below the threshold', () => {
    expect(promotionDecision({ uses: uses(4), policy: DEFAULT_POLICY }).promote).toBe(false);
  });

  it('refuses on a non-answer spike', () => {
    expect(promotionDecision({ uses: [...uses(4), ...uses(2, 'non-answer')], policy: DEFAULT_POLICY }).reason).toBe('non_answer_spike');
  });

  it('does not count skipped blocks as uses', () => {
    expect(promotionDecision({ uses: [...uses(4), ...uses(3, 'skipped')], policy: DEFAULT_POLICY }).promote).toBe(false);
  });
});
