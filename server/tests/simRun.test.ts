import { describe, it, expect } from 'vitest';
import { permutations, renderReport, type CellResult } from '../src/sim/run.js';
import { PEER_IDS } from '../src/sim/peers.js';

describe('permutations', () => {
  const perms = permutations();

  it('produces the six seatings of the three peers', () => {
    expect(perms).toHaveLength(6);
    expect(new Set(perms.map((p) => `${p.interviewer}/${p.candidate}/${p.judge}`)).size).toBe(6);
  });

  it('never seats one peer in two chairs at once', () => {
    for (const p of perms) {
      expect(new Set([p.interviewer, p.candidate, p.judge]).size).toBe(3);
    }
  });

  it('gives every peer a turn in every seat across the sweep', () => {
    for (const peer of PEER_IDS) {
      expect(perms.some((p) => p.interviewer === peer)).toBe(true);
      expect(perms.some((p) => p.candidate === peer)).toBe(true);
      expect(perms.some((p) => p.judge === peer)).toBe(true);
    }
  });

  it('always judges with a peer that had no hand in the interview', () => {
    // The whole reason for the third seat: a model scoring its own interview,
    // or one it supplied the answers for, is not an independent verdict.
    for (const p of perms) {
      expect(p.judge).not.toBe(p.interviewer);
      expect(p.judge).not.toBe(p.candidate);
    }
  });
});

describe('renderReport', () => {
  const perm = permutations()[0];

  function cell(band: 'emerging' | 'senior', pitched: string, errors: string[] = []): CellResult {
    return {
      cell: { index: 0, band, family: 'data_engineering', strength: 'strong', perm },
      role: 'Junior Data Engineer',
      candidate: 'Avery Lin',
      questor: {
        transcript: {} as never,
        judged: {
          verdict: {
            pitchedBand: pitched as never,
            calibration: 5, engagement: 6, evidenceYield: 7, fairness: 9,
            notes: [], misfitQuestions: pitched === band ? [] : ['Design a multi-region platform.'],
          },
          bandDistance: pitched === band ? 0 : 2,
          objectiveCalibration: pitched === band ? 10 : 3,
          judgedBy: perm.judge,
        },
      },
      errors,
    };
  }

  it('reports the headline metrics', () => {
    const out = renderReport([cell('emerging', 'emerging')], Date.now());
    expect(out).toContain('Band distance');
    expect(out).toContain('Calibration');
  });

  it('breaks calibration down by band', () => {
    const out = renderReport([cell('emerging', 'senior'), cell('senior', 'senior')], Date.now());
    expect(out).toContain('Calibration by band');
    expect(out).toContain('emerging');
    expect(out).toContain('senior');
  });

  it('surfaces the questions the judge called wrong for the level', () => {
    const out = renderReport([cell('emerging', 'senior')], Date.now());
    expect(out).toContain('Design a multi-region platform.');
  });

  it('lists failed cells rather than hiding them', () => {
    const out = renderReport([cell('emerging', 'emerging', ['laneA: peer timed out'])], Date.now());
    expect(out).toContain('Cells with errors');
    expect(out).toContain('peer timed out');
  });

  it('says plainly that failed cells are excluded, not counted as zero', () => {
    // A sweep that silently averages failures as zeros reports a regression that
    // is really an outage.
    const out = renderReport([cell('emerging', 'emerging', ['laneB: broke'])], Date.now());
    expect(out).toMatch(/excluded from the averages/i);
  });

  it('renders without judged results rather than throwing', () => {
    const bare: CellResult = {
      cell: { index: 0, band: 'senior', family: 'data_engineering', strength: 'strong', perm },
      role: 'Lead Data Engineer', candidate: 'Avery Lin', errors: ['fixtures: peer failed'],
    };
    expect(() => renderReport([bare], Date.now())).not.toThrow();
    expect(renderReport([bare], Date.now())).toContain('—');
  });
});
