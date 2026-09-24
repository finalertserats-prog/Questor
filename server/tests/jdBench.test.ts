import { describe, it, expect } from 'vitest';
import { runBench } from '../bench/jd/score.js';
import { GOLD_CASES } from '../bench/jd/cases/index.js';

/**
 * The floor under competency extraction.
 *
 * Everything else in this feature is a rule someone can argue with. This is
 * the number, measured against 37 job descriptions labelled by hand with what
 * a hiring manager would expect, what must never appear, and which of them are
 * hard requirements.
 *
 * It is deliberately a *floor* rather than a snapshot: improving the extractor
 * must never require editing this file, and degrading it must always fail
 * here. Re-run the numbers yourself with
 *
 *   npm run jd:bench -w server              what it does now, and every defect
 *   npx tsx bench/jd/run.ts --compare       against the extractor it replaced
 *
 * Shipped at precision 94.8%, recall 92.0%, F1 93.4%, on 37 cases across 25
 * catalog domains and all six experience bands. The floors below sit a little
 * under those, so ordinary drift shows up as a failure rather than noise.
 */

const SHIPPED = { precision: 0.90, recall: 0.88, cases: 25, domains: 15 };

describe('competency extraction, measured', () => {
  const summary = runBench(GOLD_CASES);

  it('has a gold set worth measuring against', () => {
    expect(GOLD_CASES.length).toBeGreaterThanOrEqual(SHIPPED.cases);
    expect(new Set(GOLD_CASES.map((c) => c.domain)).size).toBeGreaterThanOrEqual(SHIPPED.domains);
    expect(new Set(GOLD_CASES.map((c) => c.band)).size).toBeGreaterThanOrEqual(4);
  });

  it('keeps precision at or above the level it shipped at', () => {
    expect(summary.precision).toBeGreaterThanOrEqual(SHIPPED.precision);
  });

  it('keeps recall at or above the level it shipped at', () => {
    expect(summary.recall).toBeGreaterThanOrEqual(SHIPPED.recall);
  });

  /**
   * The one that is not a threshold.
   *
   * A forbidden competency is a competency the advert gives no grounds for —
   * a collaboration mention of somebody else's discipline, a tool another team
   * owns, a perk, a line of legal boilerplate. Every one of them becomes
   * something a real candidate is measured and scored against. There is no
   * acceptable rate.
   */
  it('proposes nothing the job description gives no grounds for', () => {
    const offenders = summary.cases
      .filter((c) => c.forbiddenHits.length > 0)
      .map((c) => `${c.id}: ${c.forbiddenHits.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  /**
   * The spine of the feature. A competency that cannot cite the line it came
   * from is not proposed at all, so this can only ever be zero.
   */
  it('never proposes a competency it cannot quote the job description for', () => {
    const offenders = summary.cases
      .filter((c) => c.unsupported.length > 0)
      .map((c) => `${c.id}: ${c.unsupported.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('reports per-domain numbers, so a regression can be located', () => {
    expect(summary.byDomain.length).toBeGreaterThanOrEqual(SHIPPED.domains);
    for (const row of summary.byDomain) {
      expect(row.cases, row.domain).toBeGreaterThanOrEqual(1);
    }
  });
});
