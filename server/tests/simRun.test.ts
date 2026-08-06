import { describe, it, expect } from 'vitest';
import { permutations, renderReport, readCheckpoint, type CellResult } from '../src/sim/run.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('readCheckpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-ckpt-'));

  function write(name: string, lines: string[]): string {
    const p = join(dir, name);
    writeFileSync(p, lines.join('\n'), 'utf8');
    return p;
  }

  it('returns nothing when there is no checkpoint to resume from', () => {
    expect(readCheckpoint(join(dir, 'does-not-exist.jsonl')).size).toBe(0);
  });

  it('reads completed cells back by index', () => {
    const p = write('ok.jsonl', [
      JSON.stringify({ cell: { index: 0 }, role: 'A', candidate: 'X', errors: [] }),
      JSON.stringify({ cell: { index: 3 }, role: 'B', candidate: 'Y', errors: [] }),
    ]);
    const done = readCheckpoint(p);
    expect(done.size).toBe(2);
    expect(done.get(3)?.role).toBe('B');
    expect(done.has(1)).toBe(false);
  });

  it('survives a line truncated by a kill mid-write', () => {
    // A sweep interrupted while appending leaves a partial last line. Losing one
    // cell to that is acceptable; losing the whole resume is not.
    const p = write('torn.jsonl', [
      JSON.stringify({ cell: { index: 0 }, role: 'A', candidate: 'X', errors: [] }),
      '{"cell":{"index":1},"role":"trunc',
    ]);
    const done = readCheckpoint(p);
    expect(done.size).toBe(1);
    expect(done.has(0)).toBe(true);
  });

  it('ignores blank lines', () => {
    const p = write('blank.jsonl', [
      JSON.stringify({ cell: { index: 2 }, role: 'A', candidate: 'X', errors: [] }),
      '',
      '',
    ]);
    expect(readCheckpoint(p).size).toBe(1);
  });
});
