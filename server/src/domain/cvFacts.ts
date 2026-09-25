import type { TechLevel } from './techStack.js';

/**
 * What a CV actually says, as facts that each carry the line they came from.
 *
 * Everything downstream of a CV — the fit score, the panel HR reads, the
 * probes that reach the interview plan — has to be able to answer "where did
 * you get that?" with an exact line. So extraction produces facts with
 * provenance rather than a bag of strings, and the scorer is only ever allowed
 * to read facts. A number with no line behind it cannot be shown to anyone.
 */

export const CV_SECTIONS = ['summary', 'experience', 'education', 'skills', 'projects', 'certifications', 'other'] as const;
export type CvSection = (typeof CV_SECTIONS)[number];

/** Re-exported so a reader of the fact model finds it; it lives in fitVocabulary.ts. */
export { EXCLUDED_SIGNALS } from './fitVocabulary.js';

export type ProtectedKind =
  | 'name' | 'contact' | 'date_of_birth' | 'age' | 'gender' | 'marital_status'
  | 'nationality' | 'religion' | 'caste' | 'photograph' | 'health'
  | 'education_provenance';

/** One line of the CV as the scorer is allowed to see it. */
export interface CvLine {
  readonly index: number;
  /** The line after protected content was removed. The only text that is ever scored or quoted. */
  readonly text: string;
  readonly section: CvSection;
  /** Non-empty when something was taken out of this line, or the whole line dropped. */
  readonly removed: readonly ProtectedKind[];
  /** True when this line carried instruction-like text aimed at a model. */
  readonly injection: boolean;
}

/** A fact's provenance: the exact line, already cleared of protected content. */
export interface CvEvidence {
  readonly line: number;
  readonly quote: string;
  readonly section: CvSection;
}

export interface CvRoleHeld {
  readonly title: string;
  readonly employer: string;
  readonly startYear?: number;
  readonly endYear?: number;
  readonly current: boolean;
  /** Months between start and end; undefined when the CV gave no usable dates. */
  readonly months?: number;
  /** Employer size or industry, only where the CV states it. */
  readonly employerContext?: string;
  readonly evidence: CvEvidence;
  readonly bullets: readonly CvEvidence[];
}

export interface CvTechnologyUse {
  /** The canonical technology name (domain/techStack.ts), never the CV's spelling. */
  readonly name: string;
  readonly firstYear?: number;
  readonly lastYear?: number;
  readonly monthsUsed?: number;
  /** Years since the technology was last used, from the roles it appears in. */
  readonly recencyYears?: number;
  readonly evidence: readonly CvEvidence[];
}

export type CvScopeKind = 'team' | 'budget' | 'scale' | 'revenue';

export interface CvScopeFact {
  readonly kind: CvScopeKind;
  /** What the CV said, e.g. "team of 14", "£2.4m", "40m requests/day". */
  readonly value: string;
  /** The figure itself, for band comparison; undefined when it is not a plain number. */
  readonly magnitude?: number;
  readonly evidence: CvEvidence;
}

export interface CvQualification {
  /** bachelor | master | doctorate | diploma | certification — never the institution. */
  readonly level: 'doctorate' | 'master' | 'bachelor' | 'diploma' | 'certification';
  /** The subject, where the CV names one. */
  readonly field: string;
  /**
   * Display only. The institution and year are captured so HR can read the CV
   * back, and are structurally out of reach of the scorer — a school's name and
   * a graduation year are proxies for nationality and age.
   */
  readonly displayOnly: { readonly institution: string; readonly year?: number };
  readonly evidence: CvEvidence;
}

export interface CvGap {
  readonly fromYear: number;
  readonly toYear: number;
  readonly months: number;
}

export interface CvTenure {
  /** Months actually accounted for by dated roles, not the span of the CV. */
  readonly accountedMonths?: number;
  readonly medianRoleMonths?: number;
  readonly longestRoleMonths?: number;
  readonly roleCount: number;
}

export interface RedactionReport {
  /** Lines removed in full because they carried nothing but protected content. */
  readonly linesRemoved: number;
  readonly kinds: readonly ProtectedKind[];
  /** Lines that tried to instruct a model. Never sent to one, never scored. */
  readonly injectionLines: readonly number[];
}

export interface CvFacts {
  readonly roles: readonly CvRoleHeld[];
  readonly technologies: readonly CvTechnologyUse[];
  readonly qualifications: readonly CvQualification[];
  readonly scope: readonly CvScopeFact[];
  readonly gaps: readonly CvGap[];
  readonly tenure: CvTenure;
  /**
   * Stated by the candidate or absent. Neither is scored: location is a proxy
   * for national origin, and work authorisation is a yes/no an employer checks,
   * not a measure of how good someone is at the job.
   */
  readonly statedLocation?: CvEvidence;
  readonly statedWorkAuthorisation?: CvEvidence;
  /** The lines the scorer may read, in order. */
  readonly lines: readonly CvLine[];
  readonly redaction: RedactionReport;
  /** Whether the configured model refined the deterministic parse, or it stood alone. */
  readonly source: 'deterministic' | 'model_assisted';
  /** Present when a model was asked and did not answer usefully. */
  readonly modelNote?: string;
}

/** The technologies a set of facts evidences, lower-cased, for quick membership tests. */
export function technologyNames(facts: Pick<CvFacts, 'technologies'>): Set<string> {
  return new Set(facts.technologies.map((t) => t.name.toLowerCase()));
}

/** Job-hopping as a shape rather than a judgement: short median tenure across several roles. */
export function looksFragmented(tenure: CvTenure): boolean {
  return tenure.roleCount >= 3 && typeof tenure.medianRoleMonths === 'number' && tenure.medianRoleMonths < 18;
}

export const EMPTY_TENURE: CvTenure = { roleCount: 0 };

export function emptyFacts(): CvFacts {
  return {
    roles: [], technologies: [], qualifications: [], scope: [], gaps: [],
    tenure: EMPTY_TENURE, lines: [],
    redaction: { linesRemoved: 0, kinds: [], injectionLines: [] },
    source: 'deterministic',
  };
}

export type { TechLevel };
