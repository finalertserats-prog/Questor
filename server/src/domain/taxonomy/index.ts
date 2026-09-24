import { competencyKeyOf } from '../calibration.js';
import { TECHNICAL_COMPETENCIES } from './technical.js';
import { BUSINESS_COMPETENCIES } from './business.js';
import { CROSS_CUTTING_COMPETENCIES } from './crossCutting.js';
import type { CanonicalCompetency, CanonicalCompetencyDef, DomainTag } from './types.js';

export type { CanonicalCompetency, CanonicalCompetencyDef, DomainTag, CanonicalRoleProfile } from './types.js';

/**
 * The assembled vocabulary.
 *
 * Keys are derived from names here rather than written in the data files, so a
 * rename can never leave a stale key behind pointing at nothing.
 */
function assemble(defs: readonly CanonicalCompetencyDef[]): CanonicalCompetency[] {
  return defs.map((def) => ({
    ...def,
    key: competencyKeyOf(def.name),
    cues: def.cues.map(allowInflection),
  }));
}

/**
 * Endings a cue's last word may take and still be the same requirement.
 *
 * A cue written as `\b(rest api|integration test|nda)\b` cannot match "REST
 * APIs", "integration tests" or "NDAs": the closing word boundary lands
 * between "api" and "s", where there is no boundary at all. Adverts are
 * written in the plural and the gerund far more often than the singular, so
 * this was not an edge case — it cost a lawyer the whole Legal & Contracting
 * competency, because "customer MSAs and NDAs" and "liability caps,
 * indemnities" both failed on nothing but a trailing "s".
 *
 * `indemnit` is the proof that it was a mistake rather than a choice: it is a
 * deliberately truncated stem that the closing boundary made unmatchable by
 * construction.
 */
const INFLECTION = '(?:s|es|ing|ling|ed|led|er|ers|ors?|ies|y|ly)?';

/** Let a cue's final word inflect, without loosening its start. */
function allowInflection(re: RegExp): RegExp {
  if (!re.source.endsWith(')\\b')) return re;
  return new RegExp(`${re.source.slice(0, -2)}${INFLECTION}\\b`, re.flags);
}

export const CANONICAL_COMPETENCIES: readonly CanonicalCompetency[] = [
  ...assemble(TECHNICAL_COMPETENCIES),
  ...assemble(BUSINESS_COMPETENCIES),
  ...assemble(CROSS_CUTTING_COMPETENCIES),
];

const BY_KEY = new Map(CANONICAL_COMPETENCIES.map((c) => [c.key, c]));

/**
 * Every name that resolves to a canonical entry: its own, and each alias.
 *
 * This is what stops near-duplicates being invented. An extractor — or a model
 * — that would have produced "Data Warehousing / SQL" lands on the canonical
 * "SQL & Data Warehousing" instead, which is the spelling the shared
 * calibration and every organisation's competency library already group on.
 */
const BY_NAME = new Map<string, CanonicalCompetency>();
for (const c of CANONICAL_COMPETENCIES) {
  BY_NAME.set(c.key, c);
  for (const alias of c.aliases) {
    const key = competencyKeyOf(alias);
    if (!BY_NAME.has(key)) BY_NAME.set(key, c);
  }
}

export function canonicalByKey(key: string): CanonicalCompetency | null {
  return BY_KEY.get(competencyKeyOf(key)) ?? null;
}

/** The canonical entry a name means, by its own name or any alias. */
export function resolveCanonical(name: string): CanonicalCompetency | null {
  return BY_NAME.get(competencyKeyOf(name)) ?? null;
}

/** Proposed on every role regardless of the advert, and labelled as such. */
export function baselineCompetencies(): readonly CanonicalCompetency[] {
  return CANONICAL_COMPETENCIES.filter((c) => c.baseline === true);
}

/** Everything that must earn its place from the job description. */
export function extractableCompetencies(): readonly CanonicalCompetency[] {
  return CANONICAL_COMPETENCIES.filter((c) => c.baseline !== true);
}

/** Entries ordinarily asked for in a domain. An entry with no domains belongs to all of them. */
export function competenciesForDomain(tag: DomainTag): readonly CanonicalCompetency[] {
  return CANONICAL_COMPETENCIES.filter((c) => c.domains.length === 0 || c.domains.includes(tag));
}
