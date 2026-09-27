import type { CvFacts } from './cvFacts.js';

/**
 * What the CV says, shaped for a person to read — and for nothing else.
 *
 * Lane 1 of candidate intake. The evidence-backed facts have been parsed and
 * stored since the fit engine was written and no screen ever showed them: HR
 * saw a score against one role and a legacy summary carrying no provenance, so
 * "what does this CV actually say, and where does it say it" had no answer in
 * the product, and checking a parse meant reading the CV again.
 *
 * Deliberately NOT here:
 *   - any score, band, ranking or comparison. A judgement needs a role to be
 *     judged against, and everything role-shaped lives in Lane 2. A number
 *     attached to a person rather than to a requirement has no
 *     job-relatedness to defend and is bias with fewer places to look for it.
 *   - `lines`. That is the scorer's input, already stripped of protected
 *     detail. The browser holds the real document, and shipping a second,
 *     subtly different rendering of a CV beside it invites the two to be
 *     confused for one another.
 */
export type ProfileAsRead = Omit<CvFacts, 'lines'>;

export function profileAsRead(facts: CvFacts): ProfileAsRead {
  const { lines: _lines, ...rest } = facts;
  return rest;
}
