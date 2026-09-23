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

  it('reads the shape the calibration lane actually sends', () => {
    // Copied from server/src/domain/calibrationView.ts — AssessmentCalibration
    // and CalibrationCompetencyView, as GET /api/assessments/:id carries them.
    // `note` is optional there and `level` is `number | null`, so both are
    // exercised here rather than assumed.
    const cal = readCalibration({
      competencies: [
        {
          competencyId: 'reliability',
          level: 3,
          provenance: 'The model graded 2/5; this organisation’s reviewers have moved it up by about one level '
            + 'across 62 observations from 7 reviewers. A reviewer has since set 4/5, and theirs is the level that counts.',
        },
        { competencyId: 'api-design', level: null, provenance: 'Not enough evidence to move this one.' },
      ],
    });
    expect(cal.present).toBe(true);
    expect(cal.note).toBe('');
    expect(cal.byCompetency.get('reliability')?.level).toBe(3);
    expect(cal.byCompetency.get('api-design')?.level).toBeNull();
    expect(cal.byCompetency.get('reliability')?.provenance).toContain('62 observations');
  });

  it('renders nothing for the empty block that lane sends when nothing moved', () => {
    // `EMPTY` there is `{}` — competencies absent, not an empty array.
    expect(readCalibration({}).present).toBe(false);
  });

  it('drops the entries it cannot use rather than rendering blanks', () => {
    const cal = readCalibration({ competencies: [{ competencyId: 'c2', level: 3 }, { competencyId: '', level: 1 }] });
    expect([...cal.byCompetency.keys()]).toEqual(['c2']);
    expect(cal.byCompetency.get('c2')?.provenance).toBe('');
  });
});
