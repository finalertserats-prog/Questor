import type { CvEvidence, CvFacts, CvLine } from '../domain/cvFacts.js';
import {
  ELIGIBILITY_CV_TERMS, credentialKindOf, distinctiveWords,
  type EligibilityRead, type EligibilityRequirement,
} from '../domain/eligibility.js';
import { segmentJd } from './jdSections.js';

/**
 * The eligibility lane: read the advert for the requirements a conversation
 * cannot settle, then read the CV for whatever it says about them.
 *
 * What this never does is decide. There is no score here, no threshold, no
 * pass and no fail — the output is a list of things a person has to check and
 * the lines of the CV that speak to each one. The owner's rule for this
 * feature was "always create the evidence and a human reviews it", and the
 * shape of this module is that sentence: evidence out, judgement elsewhere.
 *
 * The same standard the rest of the product holds itself to applies: a
 * requirement Questor cannot quote from the advert is not shown at all. A
 * requirement with no span is an assertion, and this product does not make
 * assertions (see engines/jdCompetencies.ts).
 */

/** A scorecard that puts more than this in front of a reviewer is not being read. */
export const MAX_ELIGIBILITY_REQUIREMENTS = 12;

/** How many CV lines are quoted against one requirement before it stops being a quote. */
const MAX_QUOTES = 3;

/**
 * Every eligibility requirement the advert states, each carrying its own line.
 *
 * Sectioning has already done the work: `segmentJd` files a credential-shaped
 * line under `eligibility`, which weighs nothing, so the same decision that
 * keeps a licence off the scorecard is the one that puts it here. There is no
 * second set of rules to drift out of step with the first.
 */
export function eligibilityRequirements(sourceText: string): EligibilityRequirement[] {
  const out: EligibilityRequirement[] = [];
  const seen = new Set<string>();
  for (const section of segmentJd(sourceText)) {
    if (section.kind !== 'eligibility') continue;
    for (const line of section.lines) {
      const kind = credentialKindOf(line.text);
      if (!kind) continue;
      const key = line.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `elig-${line.line}`, kind, text: line.text, line: line.line });
      if (out.length >= MAX_ELIGIBILITY_REQUIREMENTS) return out;
    }
  }
  return out;
}

/**
 * What this CV says about each requirement — and nothing about the candidate.
 *
 * The wording of the empty case is the part that matters. A CV that does not
 * mention a licence is not a CV that proves there is none: people leave
 * credentials off CVs constantly, and the difference between "Questor could
 * not see this" and "this person does not have it" is the difference between a
 * useful flag and a defamatory one.
 *
 * Note what a reviewer will NOT find quoted back for an education requirement:
 * the institution and the graduation year are removed from the CV before any
 * of this runs (engines/cvRedaction.ts), because they are proxies for
 * nationality and age. The subject and the level survive, which is what the
 * requirement actually asks about.
 */
export function readEligibility(
  requirements: readonly EligibilityRequirement[],
  facts: CvFacts,
): EligibilityRead[] {
  if (requirements.length === 0) return [];
  const lines = facts.lines.filter((l) => !l.injection);
  return requirements.map((requirement) => {
    const evidence = quotesFor(requirement, lines);
    return {
      id: requirement.id,
      kind: requirement.kind,
      requirement: requirement.text,
      line: requirement.line,
      evidence,
      note: evidence.length === 0 ? NOTHING_FOUND : foundNote(evidence.length),
    };
  });
}

const NOTHING_FOUND =
  'Nothing on this CV mentions this. That is Questor finding no mention of it, which is not evidence '
  + 'that the candidate does not hold it — credentials are left off CVs all the time. Ask them, and record what they say.';

function foundNote(count: number): string {
  return count === 1
    ? 'One line of the CV mentions this. Whether it actually meets what the advert asks for is a judgement, and it is yours to make.'
    : `${count} lines of the CV mention this. Whether they actually meet what the advert asks for is a judgement, and it is yours to make.`;
}

/**
 * The CV lines worth putting in front of a reviewer for one requirement.
 *
 * Two ways in: the vocabulary of the credential's kind ("licence", "degree",
 * "cleared"), and the requirement's own distinctive words, which is what
 * connects "a degree in nursing" to a CV line reading "BSc Nursing". Education
 * and certification sections are read first, because that is where a credential
 * usually is and a reviewer should see the strongest line rather than the
 * earliest one.
 */
function quotesFor(requirement: EligibilityRequirement, lines: readonly CvLine[]): CvEvidence[] {
  const terms = ELIGIBILITY_CV_TERMS[requirement.kind];
  const words = distinctiveWords(requirement.text);
  const matched = lines.filter((line) => {
    const lower = line.text.toLowerCase();
    return terms.some((re) => re.test(line.text)) || words.some((w) => lower.includes(w));
  });
  return [...matched]
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section))
    .slice(0, MAX_QUOTES)
    .map((line) => ({ line: line.index, quote: line.text, section: line.section }));
}

const SECTION_RANK: Readonly<Record<string, number>> = {
  certifications: 0, education: 1, summary: 2, experience: 3, skills: 4, projects: 5, other: 6,
};

function sectionRank(section: string): number {
  return SECTION_RANK[section] ?? 9;
}
