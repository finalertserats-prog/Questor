import { describe, it, expect } from 'vitest';
import { CANONICAL_COMPETENCIES } from '../src/domain/taxonomy/index.js';
import { EXCLUSION_RULES } from '../src/engines/jdExclusions.js';

/**
 * A cue that cannot match its own words.
 *
 * Twice in this feature's history a pattern was written that could never fire,
 * and both survived reading because the regex looks perfectly correct:
 *
 *   /\b(equal opportunit|diversity)\b/      "equal opportunit" is a prefix, so
 *                                           the closing \b lands between "t"
 *                                           and "y" and never matches.
 *   /\b(rest api|integration test|nda)\b/   never matches "REST APIs" either,
 *                                           for exactly the same reason — and
 *                                           that one cost a lawyer's advert
 *                                           its entire Legal & Contracting
 *                                           competency before the benchmark
 *                                           caught it.
 *
 * A pattern that silently never fires is the worst kind of defect here,
 * because the product carries on looking like it is working. So every literal
 * alternative in every cue is made to match itself. This is a cheap test that
 * catches an expensive and invisible class of mistake.
 */

/**
 * Pull the plain-text alternatives out of a pattern.
 *
 * Only alternatives made entirely of ordinary characters are checked: anything
 * containing regex syntax is a deliberate construction whose "own words" are
 * not well defined, and guessing at them would produce false alarms. That
 * still leaves the great majority of cues covered.
 */
function literalAlternatives(source: string): string[] {
  // Only the plain shape \b( a | b | c )\b is inspected — optionally with the
  // inflection suffix the registry appends. Anything with nesting, optionals
  // or character classes is skipped rather than guessed at: a parser that
  // splits naively on "|" walks straight into nested groups and reports
  // fragments like "deep )?sql" as broken alternatives, which is a false
  // alarm and would make this test useless noise. The simple shape is where
  // the bug lives anyway.
  const shape = /^\\b\(([^()[\]?*+{}\\]+)\)(?:\(\?:[^()]*\)\?)?\\b$/.exec(source);
  if (!shape) return [];
  return shape[1]
    .split('|')
    .map((part) => part.trim())
    .filter((text) => text.length >= 3 && /^[a-z0-9 &-]+$/i.test(text));
}

describe('every cue can match its own words', () => {
  for (const competency of CANONICAL_COMPETENCIES) {
    it(`${competency.name}`, () => {
      const unfireable: string[] = [];
      for (const cue of competency.cues) {
        for (const literal of literalAlternatives(cue.source)) {
          // In a sentence, the way an advert would actually write it — not
          // bare, because a bare string can pass a pattern that a real line
          // would not.
          if (!cue.test(`We need ${literal} for this role.`)) {
            unfireable.push(`${literal}  [${cue.source}]`);
          }
        }
      }
      expect(unfireable, `${competency.name} has cues that can never match`).toEqual([]);
    });
  }
});

describe('every exclusion rule can match its own words', () => {
  for (const rule of EXCLUSION_RULES) {
    it(`${rule.id}`, () => {
      // Anchored rules describe the start of a line, so they are tested there.
      const anchored = rule.re.source.startsWith('^');
      const unfireable = literalAlternatives(rule.re.source).filter(
        (literal) => !rule.re.test(anchored ? `${literal} and so on.` : `The advert says ${literal} here.`),
      );
      expect(unfireable, `${rule.id} has alternatives that can never match`).toEqual([]);
    });
  }
});

describe('the inflection allowance actually reaches the cues', () => {
  const sql = CANONICAL_COMPETENCIES.find((c) => c.key === 'sql & data warehousing')!;
  const api = CANONICAL_COMPETENCIES.find((c) => c.key === 'api & service design')!;
  const legal = CANONICAL_COMPETENCIES.find((c) => c.key === 'legal & contracting')!;
  const testing = CANONICAL_COMPETENCIES.find((c) => c.key === 'testing & quality engineering')!;

  const fires = (c: typeof sql, line: string) => c.cues.some((re) => re.test(line));

  it('matches the plural, which is how adverts are written', () => {
    expect(fires(api, 'Designing and versioning REST APIs consumed by third parties.')).toBe(true);
    expect(fires(legal, 'Draft and negotiate customer MSAs and NDAs.')).toBe(true);
    expect(fires(testing, 'Write unit and integration tests that let us ship on a Friday.')).toBe(true);
  });

  it('matches the gerund', () => {
    expect(fires(sql, 'Responsible for query tuning across the warehouse.')).toBe(true);
  });

  it('matches a truncated stem, which is why one was written that way', () => {
    expect(fires(legal, 'Advise on liability caps, indemnities and the clauses that matter.')).toBe(true);
  });
});
