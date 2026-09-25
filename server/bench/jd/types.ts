import type { BandId } from '../../src/engines/experienceBands.js';
import type { DomainTag } from '../../src/domain/taxonomy/types.js';

/**
 * A hand-labelled job description.
 *
 * These are written, not scraped: a real advert cannot be committed to this
 * repository, and a synthetic one can be labelled honestly. Each is shaped
 * like the adverts the product actually receives — headings people really use,
 * a company blurb, a perks list, a trailing equal-opportunity paragraph — and
 * carries the traps that matter, especially collaboration mentions of other
 * disciplines.
 *
 * `expect` names what a hiring manager would expect on the scorecard.
 * `forbid` names what must not appear, and is where the real value is: a
 * measurement that only rewards recall would be satisfied by proposing
 * everything.
 *
 * The four platform baseline competencies are deliberately absent from both
 * lists. They are on every role by construction, so counting them would
 * flatter every score equally and measure nothing.
 */
export interface JdGoldCase {
  readonly id: string;
  readonly domain: DomainTag;
  readonly title: string;
  readonly band: BandId;
  readonly jd: string;
  /** Canonical competency names a hiring manager would expect to see. */
  readonly expect: readonly string[];
  /** Canonical names that must NOT be proposed, and why each one is a trap. */
  readonly forbid: readonly string[];
  /** Of `expect`, the ones that must come out classified essential. */
  readonly mustHave: readonly string[];
  /** One line on what this case is testing, printed in the report. */
  readonly note: string;
}
