/**
 * Where a competency came from, put into words for the role page.
 *
 * A competency is the strongest claim Questor makes: every candidate for the
 * role is measured against it. Interview evidence quotes the transcript and a
 * CV fact quotes the CV, but until now a competency cited nothing at all — a
 * reader had no way to ask "why is this on my scorecard?".
 *
 * So each competency either shows the job description line it was read from,
 * or says plainly that it has none. Nothing here invents a provenance it was
 * not given: an older scorecard, drafted before source lines were kept, says
 * so rather than showing an empty quote.
 *
 * Kept free of React so it can be unit tested (web/tests/competencySource.test.ts).
 */

import { humanise } from '../statusModel';

export interface CompetencySource {
  /** The verbatim job description line. */
  readonly text: string;
  /** 1-based line number in the role's source text. */
  readonly line: number;
  readonly section: string;
}

/** The provenance the server may carry on a competency. Every field is optional: scorecards drafted before spans existed have none of them. */
export interface CompetencyProvenance {
  readonly source?: CompetencySource;
  /** The same line as plain text. Older records have only this. */
  readonly sourceText?: string;
  readonly origin?: 'jd' | 'baseline' | 'tech_stack' | string;
  readonly confidence?: number;
  readonly lowConfidence?: boolean;
  readonly rationale?: string;
}

/**
 * Said the way the extractor says it, so the page and the rationale sentence
 * beneath it never name the same section two different ways.
 */
const SECTION_LABELS: Readonly<Record<string, string>> = {
  requirements: 'Requirements',
  responsibilities: 'Responsibilities',
  nice_to_have: 'Nice to have',
  role_summary: 'Role summary',
  company: 'Company description',
  benefits: 'Benefits',
  boilerplate: 'Boilerplate',
  unknown: 'Job description',
};

export const BASELINE_NOTE = 'Asked on every role, not taken from this advert.';
export const TECH_STACK_NOTE = "Asked because of this role's tech stack, not taken from a line of this advert.";
export const NO_SPAN_NOTE = 'No job description line is recorded for this one — it was added by hand, or drafted before source lines were kept.';

/** A section key as a reader should see it. An unfamiliar key is shown rather than hidden. */
export function sectionLabel(section: string | undefined): string {
  const key = (section ?? '').trim().toLowerCase();
  if (!key) return SECTION_LABELS.unknown;
  return SECTION_LABELS[key] ?? humanise(key);
}

/** "Requirements, line 18" — or just the section when no usable line number came with it. */
export function sourceCitation(source: { readonly line?: number; readonly section?: string } | null | undefined): string {
  const label = sectionLabel(source?.section);
  const line = source?.line;
  if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) return label;
  return `${label}, line ${Math.floor(line)}`;
}

function tidy(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export type ProvenanceRead =
  /** The advert says it, here are its words. */
  | { readonly kind: 'span'; readonly quote: string; readonly citation: string; readonly uncertain: boolean; readonly rationale: string | null }
  /** It is on the scorecard for a reason that is not this advert, and that reason is named. */
  | { readonly kind: 'stated'; readonly note: string; readonly uncertain: boolean; readonly rationale: string | null }
  /** Nothing is recorded, and the page says exactly that. */
  | { readonly kind: 'none'; readonly note: string; readonly uncertain: boolean; readonly rationale: string | null };

/**
 * What to show beneath a competency. `source` is preferred over `sourceText`
 * because only the former can cite a line; a blank span is treated as no span
 * rather than rendered as an empty quotation.
 */
export function provenanceOf(competency: CompetencyProvenance): ProvenanceRead {
  const uncertain = competency.lowConfidence === true;
  const rationale = tidy(competency.rationale) || null;
  const quote = tidy(competency.source?.text) || tidy(competency.sourceText);

  if (quote) {
    const citation = competency.source ? sourceCitation(competency.source) : sectionLabel(undefined);
    return { kind: 'span', quote, citation, uncertain, rationale };
  }
  if (competency.origin === 'baseline') return { kind: 'stated', note: BASELINE_NOTE, uncertain, rationale };
  if (competency.origin === 'tech_stack') return { kind: 'stated', note: TECH_STACK_NOTE, uncertain, rationale };
  return { kind: 'none', note: NO_SPAN_NOTE, uncertain, rationale };
}
