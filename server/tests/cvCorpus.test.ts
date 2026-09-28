import { describe, expect, it } from 'vitest';
import { CV_CORPUS, corpusTotals, measureCorpus, measureFixture } from './fixtures/cv/measure.js';

/**
 * The CV corpus, as a floor rather than a report.
 *
 * "The parser should work exceptionally right" is not something anyone can
 * check. These numbers are. Every fixture under tests/fixtures/cv is a
 * document the parser meets in production — four languages, day-first and
 * month-first dates, a two-column PDF, a scan, headings nobody taught it, and
 * a page that is not a CV — and every one carries the answer, written from
 * the DOCUMENT rather than from what the parser happens to do.
 *
 * Measured against the parser as it stood before this change:
 *
 *   current-role recall      3/8  (38%)  ->  8/8  (100%)
 *   role recall             12/20 (60%)  -> 20/20 (100%)
 *   date accuracy           12/20 (60%)  -> 20/20 (100%)
 *   technology recall       41/41 (100%) -> 41/41 (100%)
 *   invented technologies    2           ->  0
 *   years-of-experience      4/9  (44%)  ->  9/9  (100%)
 *   flagging accuracy        8/11 (73%)  -> 11/11 (100%)
 *   noise rejection          0/1  (0%)   ->  1/1  (100%)
 *
 * The thresholds below are the floor, not the achievement. They are set at
 * 100% because that is where the corpus currently sits and a regression on
 * any one of these is a real candidate mis-read; when the corpus grows a
 * harder document, the honest move is to add it and let this go red, not to
 * lower the number.
 */

describe('the CV corpus', () => {
  const rows = measureCorpus();
  const totals = corpusTotals(rows);

  it('reads the current role on every CV that has one', () => {
    const missed = rows.filter((r) => r.currentRoleExpected && !r.currentRoleCorrect).map((r) => r.id);
    expect(missed).toEqual([]);
    expect(totals.currentRoleRecall[0]).toBe(totals.currentRoleRecall[1]);
  });

  it('finds every role the documents contain', () => {
    const short = rows.filter((r) => r.rolesMatched < r.rolesExpected).map((r) => `${r.id} ${r.rolesMatched}/${r.rolesExpected}`);
    expect(short).toEqual([]);
  });

  it('gets both ends of every date right', () => {
    const wrong = rows.filter((r) => r.datesCorrect < r.rolesExpected).map((r) => `${r.id} ${r.datesCorrect}/${r.rolesExpected}`);
    expect(wrong).toEqual([]);
  });

  it('invents no technology on any document', () => {
    const invented = rows.filter((r) => r.techFalsePositives.length > 0).map((r) => `${r.id}: ${r.techFalsePositives.join(',')}`);
    expect(invented).toEqual([]);
  });

  it('finds every technology the documents name', () => {
    const missed = rows.filter((r) => r.techFound < r.techExpected).map((r) => `${r.id} ${r.techFound}/${r.techExpected}`);
    expect(missed).toEqual([]);
  });

  it('reports years of experience the document supports', () => {
    const wrong = rows.filter((r) => r.totalYearsInRange === false).map((r) => `${r.id}: ${r.totalYears}`);
    expect(wrong).toEqual([]);
  });

  it('flags the documents that deserve it and only those', () => {
    const wrong = rows.filter((r) => !r.flaggedAsExpected).map((r) => `${r.id}: ${r.flagCount} flags`);
    expect(wrong).toEqual([]);
  });

  it('refuses the document that is not a CV', () => {
    expect(totals.noiseRejection[0]).toBe(totals.noiseRejection[1]);
  });

  it('measures every fixture, so a fixture cannot be added and forgotten', () => {
    expect(rows).toHaveLength(CV_CORPUS.length);
    expect(rows.length).toBeGreaterThanOrEqual(11);
  });
});

describe('the measurement itself', () => {
  /**
   * A corpus that cannot fail is a corpus that proves nothing. This checks the
   * harness would report a miss if there were one, by asking it for a role the
   * document does not contain.
   */
  it('reports a miss when the document does not contain what is expected', () => {
    const real = CV_CORPUS.find((c) => c.id === 'en-standard')!;
    const impossible = { ...real, roles: [{ titleContains: 'Chief Astronaut', startYear: 1999, endYear: 2001 as const }] };
    const measured = measureFixture(impossible);
    expect(measured.rolesMatched).toBe(0);
    expect(measured.datesCorrect).toBe(0);
  });

  it('reports an invented technology when one is present', () => {
    const real = CV_CORPUS.find((c) => c.id === 'en-standard')!;
    // Python IS in this CV, so listing it as absent must be reported.
    const measured = measureFixture({ ...real, notTechnologies: ['Python'] });
    expect(measured.techFalsePositives).toEqual(['Python']);
  });
});
