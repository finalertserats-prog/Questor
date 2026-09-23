import { describe, expect, it } from 'vitest';
import {
  changedCount, differenceRows, levelText, readCalibration,
} from '../src/components/assessment/differencesModel';

/**
 * The comparison behind Part 3. It states both values and stops; the previous
 * model also labelled each row "Reviewer graded higher"/"lower", which is the
 * system marking the human's work, and is gone.
 */

const ROWS = [
  { competencyId: 'c1', competencyName: 'System design', aiLevel: 4, humanLevel: 4, changed: false, reason: '' },
  { competencyId: 'c2', competencyName: 'Reliability', aiLevel: 2, humanLevel: 4, changed: true, reason: 'He gave the whole diagnosis at 18:40.' },
  { competencyId: 'c3', competencyName: 'API design', aiLevel: 4, humanLevel: 4, changed: false, reason: '' },
];

describe('the rows', () => {
  it('puts the ones they disagreed on first', () => {
    expect(differenceRows(ROWS).map((r) => r.competencyId)).toEqual(['c2', 'c1', 'c3']);
  });

  it('keeps the ones they agreed on, because agreement is half the measurement', () => {
    expect(differenceRows(ROWS)).toHaveLength(3);
  });

  it('states both levels as text, and never invents one', () => {
    const [changed] = differenceRows(ROWS);
    expect([changed.aiText, changed.humanText]).toEqual(['2/5', '4/5']);
    expect(levelText(null)).toBe('Not graded');
  });

  it('says when a changed level carries no reason, rather than leaving a blank cell', () => {
    const rows = differenceRows([{ ...ROWS[1], reason: '   ' }]);
    expect(rows[0].reason).toBe('No reason given.');
  });

  it('offers no characterisation of the disagreement at all', () => {
    const row = differenceRows(ROWS)[0] as unknown as Record<string, unknown>;
    expect(row.direction).toBeUndefined();
  });

  it('counts the changes plainly', () => {
    expect(changedCount(ROWS)).toBe(1);
  });
});

describe('calibration, when the calibration lane has published some', () => {
  it('is absent when nothing was sent', () => {
    expect(readCalibration(undefined).present).toBe(false);
    expect(readCalibration(null).present).toBe(false);
  });

  it('is absent when what was sent carries no usable entry', () => {
    expect(readCalibration({ competencies: [] }).present).toBe(false);
    expect(readCalibration({ competencies: [{ level: 3 }] }).present).toBe(false);
    expect(readCalibration('nonsense').present).toBe(false);
  });

  it('reads the levels and their provenance when they are there', () => {
    const cal = readCalibration({
      competencies: [{ competencyId: 'c2', level: 3, provenance: 'from 42 reviews on this role' }],
      note: 'Calibrated last night.',
    });
    expect(cal.present).toBe(true);
    expect(cal.byCompetency.get('c2')?.level).toBe(3);
    expect(cal.byCompetency.get('c2')?.provenance).toBe('from 42 reviews on this role');
    expect(cal.note).toBe('Calibrated last night.');
  });

  it('drops the entries it cannot use rather than rendering blanks', () => {
    const cal = readCalibration({ competencies: [{ competencyId: 'c2', level: 3 }, { competencyId: '', level: 1 }] });
    expect([...cal.byCompetency.keys()]).toEqual(['c2']);
    expect(cal.byCompetency.get('c2')?.provenance).toBe('');
  });
});
