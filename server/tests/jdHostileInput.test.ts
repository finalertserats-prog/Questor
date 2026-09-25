import { describe, it, expect } from 'vitest';
import { proposeFromJd } from '../src/engines/jdCompetencies.js';
import { contributingLines, maskCollaborationObjects, segmentJd } from '../src/engines/jdSections.js';
import { excludedBy } from '../src/engines/jdExclusions.js';

/**
 * A job description is untrusted input.
 *
 * It is pasted or uploaded by an organisation's own user rather than by a
 * stranger, which lowers the odds but changes nothing about the consequence:
 * every pattern in the JD path is a regular expression run over text somebody
 * else chose, and a regular expression that backtracks can hold a CPU core for
 * a minute on a page of punctuation. The CV lane found exactly that — 200,000
 * characters of "1" cost 78 seconds — so the same probe is run here.
 *
 * The inputs below are four times the 50,000-character ceiling the create
 * endpoint actually enforces, so passing at this size leaves real headroom.
 * The budget is deliberately generous: this is a test for catastrophic
 * backtracking, which fails by orders of magnitude, not a performance
 * benchmark that will flake on a loaded machine.
 */

const HUGE = 200_000;
const BUDGET_MS = 4_000;

const PROBES: ReadonlyArray<readonly [string, string]> = [
  ['a page of digits', '1'.repeat(HUGE)],
  ['a page of dashes', '-'.repeat(HUGE)],
  ['a page of spaces', ' '.repeat(HUGE)],
  ['a page of commas', ','.repeat(HUGE)],
  ['repeated short words', 'a '.repeat(HUGE / 2)],
  ['repeated possessives', 'our '.repeat(HUGE / 4)],
  // Aimed squarely at the collaboration masker and the other-party clause,
  // which are the patterns with the most alternation in them.
  ['repeated collaboration verbs', 'work with the '.repeat(HUGE / 14)],
  ['a very long team name', `Requirements:\n- ${'the data team '.repeat(5_000)}owns it.`],
  ['one enormous line', `Requirements:\n- ${'x'.repeat(HUGE)}`],
];

function timed(run: () => unknown): number {
  const started = Date.now();
  run();
  return Date.now() - started;
}

describe('hostile job descriptions', () => {
  for (const [name, text] of PROBES) {
    it(`segments ${name} without backtracking`, () => {
      expect(timed(() => segmentJd(text))).toBeLessThan(BUDGET_MS);
    });

    it(`extracts from ${name} without backtracking`, () => {
      expect(timed(() => proposeFromJd(text, { title: 'Engineer' }))).toBeLessThan(BUDGET_MS);
    });

    it(`screens and masks ${name} without backtracking`, () => {
      const line = text.slice(0, 5_000);
      expect(timed(() => {
        excludedBy(line);
        maskCollaborationObjects(line);
        contributingLines(text);
      })).toBeLessThan(BUDGET_MS);
    });
  }

  it('proposes nothing from a document that is not a job description', () => {
    expect(proposeFromJd('-'.repeat(HUGE), { title: 'Engineer' }).filter((c) => c.origin === 'jd')).toEqual([]);
  });

  it('still reads a real requirement buried in a very long advert', () => {
    const padded = `${'Filler line about nothing in particular.\n'.repeat(2_000)}Requirements:\n- Strong SQL and data warehousing.\n`;
    expect(proposeFromJd(padded, { title: 'Analyst' }).map((c) => c.name)).toContain('SQL & Data Warehousing');
  });
});
