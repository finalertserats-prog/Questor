import { describe, it, expect } from 'vitest';
import {
  BANDS,
  bandForYears,
  bandById,
  inferBand,
  bandDistance,
  type BandId,
} from '../src/engines/experienceBands.js';

describe('band table', () => {
  it('covers the years axis without gaps or overlaps', () => {
    for (let i = 1; i < BANDS.length; i++) {
      expect(BANDS[i].yearsPrior.min).toBe(BANDS[i - 1].yearsPrior.max);
    }
  });

  it('starts at zero and ends open-ended', () => {
    expect(BANDS[0].yearsPrior.min).toBe(0);
    expect(BANDS[BANDS.length - 1].yearsPrior.max).toBe(Infinity);
  });

  it('rises monotonically in abstraction', () => {
    const rank = { craft: 0, system: 1, organisation: 2 } as const;
    for (let i = 1; i < BANDS.length; i++) {
      expect(rank[BANDS[i].abstraction]).toBeGreaterThanOrEqual(rank[BANDS[i - 1].abstraction]);
    }
  });

  it('gives every band something to ask and something to avoid', () => {
    for (const b of BANDS) {
      expect(b.askAbout.length).toBeGreaterThan(0);
      expect(b.avoid.length).toBeGreaterThan(0);
      expect(b.evidenceBar.length).toBeGreaterThan(10);
    }
  });
});

describe('bandForYears', () => {
  it.each([
    [0, 'emerging'],
    [1.5, 'emerging'],
    [2, 'developing'],
    [4.9, 'developing'],
    [5, 'established'],
    [8, 'senior'],
    [12, 'principal'],
    [18, 'executive'],
    [45, 'executive'],
  ])('maps %s years to %s', (years, expected) => {
    expect(bandForYears(years).id).toBe(expected as BandId);
  });

  it('treats a missing or negative figure as the entry band', () => {
    expect(bandForYears(undefined).id).toBe('emerging');
    expect(bandForYears(-3).id).toBe('emerging');
  });
});

describe('inferBand — evidenced scope, years as prior', () => {
  it('keeps the years prior when the evidence says nothing either way', () => {
    const r = inferBand({ totalYears: 6, evidenceText: 'Worked on the reporting service.' });
    expect(r.band.id).toBe('established');
    expect(r.movedBy).toBe(0);
  });

  it('promotes a candidate whose evidence shows scope beyond their years', () => {
    const r = inferBand({
      totalYears: 4,
      evidenceText: 'Architected the billing platform across three teams and mentored 5 engineers.',
    });
    expect(r.band.id).toBe('established');
    expect(r.movedBy).toBe(1);
  });

  it('demotes a long tenure that only ever evidences task-level work', () => {
    const r = inferBand({
      totalYears: 9,
      evidenceText: 'Completed assigned tickets under supervision and assisted the senior team as directed.',
    });
    expect(r.band.id).toBe('established');
    expect(r.movedBy).toBe(-1);
  });

  it('never moves more than one band, so evidence refines rather than overrides', () => {
    const r = inferBand({
      totalYears: 0,
      evidenceText: 'Owned P&L, company-wide roadmap, board reporting, headcount and org-wide architecture.',
    });
    expect(r.band.id).toBe('developing');
    expect(r.movedBy).toBe(1);
  });

  it('does not inflate a band whose own abstraction already covers the evidence', () => {
    // A principal describing P&L and multi-team architecture is describing the
    // job, not exceeding it. Absolute markers would ratchet every senior CV up.
    const r = inferBand({
      totalYears: 14,
      evidenceText: 'Owned P&L for the platform group and set architecture across four teams.',
    });
    expect(r.band.id).toBe('principal');
    expect(r.movedBy).toBe(0);
  });

  it('still promotes when the same evidence sits above the band', () => {
    const r = inferBand({
      totalYears: 6,
      evidenceText: 'Set architecture across four teams and owned the group budget of 2M.',
    });
    expect(r.band.id).toBe('senior');
    expect(r.movedBy).toBe(1);
  });

  it('reads "across the team" as within one team, not across several', () => {
    // Singular. It describes work inside a team and must not read as multi-team
    // scope — this false positive promoted an entry-level fixture.
    const r = inferBand({ totalYears: 1, evidenceText: 'Contributed to initiatives across the team.' });
    expect(r.band.id).toBe('emerging');
    expect(r.movedBy).toBe(0);
  });

  it('reports lower confidence when evidence contradicts the years prior', () => {
    const agreeing = inferBand({ totalYears: 6, evidenceText: 'Owned the ingestion system end to end.' });
    const conflicting = inferBand({
      totalYears: 9,
      evidenceText: 'Completed assigned tickets under supervision as directed.',
    });
    expect(conflicting.confidence).toBeLessThan(agreeing.confidence);
  });

  it('falls back to the entry band when there are no years and no evidence', () => {
    const r = inferBand({ evidenceText: '' });
    expect(r.band.id).toBe('emerging');
    expect(r.confidence).toBeLessThan(0.5);
  });
});

describe('bandDistance', () => {
  it('is zero for a band against itself', () => {
    expect(bandDistance('senior', 'senior')).toBe(0);
  });

  it('counts steps and is symmetric', () => {
    expect(bandDistance('emerging', 'established')).toBe(2);
    expect(bandDistance('established', 'emerging')).toBe(2);
  });
});

describe('bandById', () => {
  it('round-trips every band id', () => {
    for (const b of BANDS) expect(bandById(b.id)).toBe(b);
  });
});
