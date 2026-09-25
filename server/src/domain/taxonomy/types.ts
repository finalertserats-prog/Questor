import type { Competency } from '../types.js';

/**
 * The shared competency vocabulary the role catalog never had.
 *
 * The catalog carries 492 roles across 35 domains, but a catalog role is only
 * a title, a family and a market signal — there is no canonical competency
 * anywhere in it, and every scorecard until now invented its competency names
 * from scratch. That is how one organisation ends up measuring "SQL & Data
 * Warehousing", another "Data Warehousing / SQL", and a third "Databases",
 * with nothing able to tell that they are the same thing.
 *
 * This file is the vocabulary. Extraction proposes from it wherever an entry
 * fits, so near-duplicates stop being invented; the keys line up with
 * `competencyKeyOf`, which is already what the shared global calibration and
 * `OrgCompetency.nameKey` group on, so a canonical competency is learnable
 * across organisations.
 *
 * It does not close the vocabulary. A job that genuinely asks for something
 * not in here still gets it — a free competency, drawn from its own JD span
 * and marked as off-taxonomy — because a hiring manager naming something real
 * must not be overruled by a list.
 */

/** The 35 catalog domains, short-tagged. `catalogDomains.ts` maps them to the catalog's own names. */
export type DomainTag =
  | 'frontier_ai' | 'ml_platform' | 'data' | 'software' | 'cloud' | 'security'
  | 'product' | 'semiconductor' | 'robotics' | 'bfsi' | 'healthcare' | 'life_sciences'
  | 'sustainability' | 'energy' | 'manufacturing' | 'supply_chain' | 'sales'
  | 'customer_success' | 'marketing' | 'hr' | 'strategy' | 'finance' | 'legal'
  | 'construction' | 'aerospace' | 'automotive' | 'agriculture' | 'retail'
  | 'hospitality' | 'education' | 'public_sector' | 'media' | 'science'
  | 'trades' | 'customer_service';

export interface CanonicalCompetency {
  /** `competencyKeyOf(name)` — the spelling calibration and the org library already group on. */
  readonly key: string;
  readonly name: string;
  readonly category: Competency['category'];
  readonly definition: string;
  readonly indicators: readonly string[];
  /**
   * Other names for the same thing. An extractor that would have invented
   * "Data Warehousing / SQL" resolves to the canonical entry instead.
   */
  readonly aliases: readonly string[];
  /**
   * Requirement-shaped phrases that evidence this competency in a job
   * description. These are matched against one line at a time, after that line
   * has had its collaboration objects masked — never against the whole advert.
   *
   * They are deliberately narrower than a keyword. "product" is not a cue for
   * Product Management; "own the roadmap" is. The difference is the whole
   * reason this file exists.
   */
  readonly cues: readonly RegExp[];
  /**
   * Lines where a cue fires but means something else entirely.
   *
   * Real collisions, all found by the bench: "GCP" is Google Cloud Platform on
   * a cloud advert and Good Clinical Practice on a trials advert;
   * "reconciliation" is a ledger on a finance advert and medicines on a
   * nursing one; a "post-mortem" is an outage to an engineer and a finished
   * campaign to a marketer. A veto is checked against the same line as the
   * cues and beats all of them.
   */
  readonly notWhen?: readonly RegExp[];
  /** Where this competency is ordinarily asked for. Empty means every domain. */
  readonly domains: readonly DomainTag[];
  /**
   * A broad umbrella that a more specific competency should beat.
   *
   * "Build streaming pipelines using Python" evidences Data Engineering and,
   * through the bare word Python, Software Engineering too. Proposing both
   * measures the candidate twice on one sentence and buries the specific
   * requirement under a generic one. A general competency therefore has to
   * earn a line of its own — see `proposeFromJd`.
   */
  readonly general?: boolean;
  /**
   * True for competencies the platform proposes on every role regardless of
   * what the advert says (Communication, Problem Solving, …). They carry no JD
   * span because they do not come from the JD, and they are labelled as such
   * rather than being passed off as extracted.
   */
  readonly baseline?: boolean;
}

/**
 * How the data files declare an entry. The key is derived from the name by the
 * registry rather than written by hand, so the two can never disagree.
 */
export type CanonicalCompetencyDef = Omit<CanonicalCompetency, 'key'>;

/** What a catalog role is usually hired for, so an omission is as visible as a spurious extra. */
export interface CanonicalRoleProfile {
  readonly id: string;
  /** Matched against the role title. */
  readonly title: RegExp;
  readonly domains: readonly DomainTag[];
  /** Canonical keys a hiring manager would expect to see on this role. */
  readonly usual: readonly string[];
  /** Of those, the ones whose absence is worth saying out loud. */
  readonly core: readonly string[];
}
