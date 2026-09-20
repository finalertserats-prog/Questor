import { describe, expect, it } from 'vitest';
import { decideGate, statusForOutcome, stratumAfterApproval, stratumAfterRejection, stratumOpen, type GateInput } from '../../src/library/policy.js';
import { DEFAULT_POLICY, type CriticVerdict } from '../../src/library/types.js';

/** The policy gate: pass → probational, unsure → owner queue, fail → rejected. */

const goodVerdict: CriticVerdict = { realQuestion: true, rightBand: true, answerable: true, formCorrect: true, anchorsLeaked: false, roleSpecific: true, confidence: 0.9, notes: '' };
const cleanLint = { ok: true, errors: [], warnings: [] };
const openStratum = { cleanApprovals: 20, tightenedRemaining: 0 };

function input(overrides: Partial<GateInput> = {}): GateInput {
  return { critic: goodVerdict, lint: cleanLint, dedupe: { kind: 'none', score: 0 }, stratum: openStratum, policy: DEFAULT_POLICY, ...overrides };
}

describe('decideGate', () => {
  it('passes a clean entry in an open stratum', () => {
    expect(decideGate(input()).outcome).toBe('pass');
  });

  it('fails when the critic says it is not a real question', () => {
    expect(decideGate(input({ critic: { ...goodVerdict, realQuestion: false } })).outcome).toBe('fail');
  });

  it('fails a generic question the critic could ask of any job in the family', () => {
    expect(decideGate(input({ critic: { ...goodVerdict, roleSpecific: false } })).reasons).toContain('critic:generic');
  });

  it('fails when anchors leaked into the question', () => {
    expect(decideGate(input({ critic: { ...goodVerdict, anchorsLeaked: true } })).outcome).toBe('fail');
  });

  it('fails without a critic verdict', () => {
    expect(decideGate(input({ critic: null })).reasons).toContain('critic:missing');
  });

  it('fails on a lint error', () => {
    expect(decideGate(input({ lint: { ok: false, errors: [{ code: 'protected', severity: 'error', detail: '' }], warnings: [] } })).outcome).toBe('fail');
  });

  it('fails a duplicate', () => {
    expect(decideGate(input({ dedupe: { kind: 'duplicate', score: 0.9, matchId: 'e1' } })).outcome).toBe('fail');
  });

  it('is unsure on a near-duplicate', () => {
    expect(decideGate(input({ dedupe: { kind: 'near', score: 0.6, matchId: 'e1' } })).outcome).toBe('unsure');
  });

  it('is unsure on a lint warning', () => {
    expect(decideGate(input({ lint: { ok: true, errors: [], warnings: [{ code: 'reading_level', severity: 'warning', detail: '' }] } })).outcome).toBe('unsure');
  });

  it('is unsure when critic confidence sits in the grey band', () => {
    expect(decideGate(input({ critic: { ...goodVerdict, confidence: 0.6 } })).outcome).toBe('unsure');
  });

  it('fails when critic confidence is below the grey band', () => {
    expect(decideGate(input({ critic: { ...goodVerdict, confidence: 0.3 } })).outcome).toBe('fail');
  });

  it('is unsure on a wrong form tag, which the owner can correct', () => {
    expect(decideGate(input({ critic: { ...goodVerdict, formCorrect: false } })).outcome).toBe('unsure');
  });

  it('sends every entry of a new stratum to the owner queue', () => {
    expect(decideGate(input({ stratum: { cleanApprovals: 3, tightenedRemaining: 0 } })).reasons).toContain('stratum:new');
  });

  it('sends entries of a tightened stratum to the owner queue', () => {
    expect(decideGate(input({ stratum: { cleanApprovals: 40, tightenedRemaining: 12 } })).reasons).toContain('stratum:tightened');
  });

  it('still fails a bad entry in a new stratum rather than queueing it', () => {
    expect(decideGate(input({ stratum: { cleanApprovals: 0, tightenedRemaining: 0 }, critic: { ...goodVerdict, realQuestion: false } })).outcome).toBe('fail');
  });
});

describe('statusForOutcome', () => {
  it('maps pass to probational', () => {
    expect(statusForOutcome('pass')).toBe('probational');
  });

  it('keeps an unsure entry as a draft for the owner queue', () => {
    expect(statusForOutcome('unsure')).toBe('draft');
  });

  it('maps fail to rejected', () => {
    expect(statusForOutcome('fail')).toBe('rejected');
  });
});

describe('stratum state', () => {
  it('opens after twenty clean approvals', () => {
    expect(stratumOpen({ cleanApprovals: 20, tightenedRemaining: 0 }, DEFAULT_POLICY)).toBe(true);
  });

  it('stays closed while tightened', () => {
    expect(stratumOpen({ cleanApprovals: 20, tightenedRemaining: 1 }, DEFAULT_POLICY)).toBe(false);
  });

  it('counts a clean approval', () => {
    expect(stratumAfterApproval({ cleanApprovals: 1, approvals: 1, rejections: 0, tightenedRemaining: 0 }, true).cleanApprovals).toBe(2);
  });

  it('does not count an edited approval as clean', () => {
    expect(stratumAfterApproval({ cleanApprovals: 1, approvals: 1, rejections: 0, tightenedRemaining: 0 }, false).cleanApprovals).toBe(1);
  });

  it('tightens the gate for the next 200 entries on a sample rejection', () => {
    expect(stratumAfterRejection({ cleanApprovals: 30, approvals: 30, rejections: 0, tightenedRemaining: 0 }, DEFAULT_POLICY).tightenedRemaining).toBe(200);
  });

  it('does not mutate the state it is given', () => {
    const before = { cleanApprovals: 30, approvals: 30, rejections: 0, tightenedRemaining: 0 };
    stratumAfterRejection(before, DEFAULT_POLICY);
    expect(before.tightenedRemaining).toBe(0);
  });
});
