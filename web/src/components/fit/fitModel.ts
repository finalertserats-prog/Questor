import { FIT_BAND_LABELS, FIT_BAND_MEANINGS, FIT_BAND_TONE, FIT_STRENGTH_LABELS, isFitBand, isFitStrength, type FitBand, type FitStrength } from './fitVocabulary';

/**
 * The shapes the fit panel reads, and the one piece of real logic it has:
 * putting what the CV claimed next to what the interview actually found.
 *
 * That comparison is the product's central claim, so it lives in a pure module
 * with its own tests rather than inside a component. It joins on competency id,
 * never on name — two competencies can share a name across scorecard versions,
 * and a name join would quietly compare the wrong two things.
 */

export interface FitEvidence { line: number; quote: string; section: string; }

export interface FitComponent {
  key: string; label: string; weight: number; score: number;
  evidence: string[]; evidenceDetail?: FitEvidence[]; rule: string; explanation?: string;
}

export interface FitCompetencyRead {
  competencyId: string; name: string; classification: string; mustHave: boolean;
  strength: FitStrength; score: number | null; evidence: FitEvidence[]; explanation: string;
}

export interface FitTechnologyRead {
  name: string; required: boolean; level: string; strength: FitStrength;
  recencyYears: number | null; monthsUsed: number | null; evidence: FitEvidence[]; explanation: string;
}

export interface FitProbe { text: string; reason: string; competencyId?: string; technology?: string; }

export interface FitRedaction { linesRemoved: number; kinds: string[]; injectionLines: number[]; }

export interface Fit {
  overall: number;
  confidence: number;
  components: FitComponent[];
  missing: string[];
  probes: string[];
  excludedSignals?: string[];
  band?: string;
  meaning?: string;
  coverage?: number;
  competencies?: FitCompetencyRead[];
  technologies?: FitTechnologyRead[];
  mustHaveGaps?: string[];
  niceToHavesPresent?: string[];
  notEvidenced?: string[];
  probeDetail?: FitProbe[];
  experience?: { roleBand: string; explanation: string };
  redaction?: FitRedaction;
  engineVersion?: string;
  scorecardVersion?: number | null;
  scoredAt?: string;
}

/** A fit stored before the evidence-backed engine has none of the detail below. */
export function isDetailedFit(fit: Fit | null): boolean {
  return Boolean(fit && Array.isArray(fit.competencies) && fit.competencies.length > 0);
}

export function bandOf(fit: Fit): FitBand {
  return isFitBand(fit.band) ? fit.band : 'not_enough_evidence';
}

export function bandLabel(fit: Fit): string {
  return FIT_BAND_LABELS[bandOf(fit)];
}

export function bandMeaning(fit: Fit): string {
  return fit.meaning ?? FIT_BAND_MEANINGS[bandOf(fit)];
}

export function bandTone(fit: Fit): 'pass' | 'hold' | 'stop' | 'neutral' {
  return FIT_BAND_TONE[bandOf(fit)];
}

/**
 * A strength this browser does not know is treated as no evidence, not as a
 * blank. An older or newer server, or a corrupted row, otherwise renders an
 * empty label next to a competency — which reads as a claim rather than as the
 * gap it actually is.
 */
export function strengthLabel(strength: FitStrength | string): string {
  return isFitStrength(strength) ? FIT_STRENGTH_LABELS[strength] : FIT_STRENGTH_LABELS.not_evidenced;
}

// --- CV against interview ---------------------------------------------------------

export interface InterviewCompetency {
  id: string;
  name: string;
  level: number | null;
  requiredLevel: number;
  notEnoughEvidence: boolean;
  evidence: Array<{ turnId: string; quote: string; startMs?: number; endMs?: number }>;
  rationale?: string;
}

export const COMPARISON_KINDS = ['interview_found_less', 'interview_went_further', 'agreed', 'neither', 'not_assessed'] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];

/**
 * What each pairing is called. Written to be precise and kind at the same time:
 * a candidate whose CV says more than the interview showed has not been caught
 * lying, and the wording must not imply it. What actually happened is that one
 * conversation did not produce the evidence, and that is what it says.
 */
export const COMPARISON_LABELS: Readonly<Record<ComparisonKind, string>> = {
  interview_found_less: 'CV said more than the interview showed',
  interview_went_further: 'Interview showed more than the CV said',
  agreed: 'CV and interview agree',
  neither: 'Neither has evidence yet',
  not_assessed: 'Not covered in this interview',
};

export const COMPARISON_TONE: Readonly<Record<ComparisonKind, 'pass' | 'hold' | 'stop' | 'neutral'>> = {
  interview_found_less: 'hold',
  interview_went_further: 'pass',
  agreed: 'pass',
  neither: 'neutral',
  not_assessed: 'neutral',
};

export interface ComparisonRow {
  competencyId: string;
  name: string;
  kind: ComparisonKind;
  cvStrength: FitStrength;
  cvEvidence: FitEvidence[];
  interviewLevel: number | null;
  requiredLevel: number | null;
  interviewEvidence: InterviewCompetency['evidence'];
  sentence: string;
}

const ORDER: Readonly<Record<ComparisonKind, number>> = {
  interview_found_less: 0, interview_went_further: 1, agreed: 2, neither: 3, not_assessed: 4,
};

function kindOf(cv: FitCompetencyRead, interview: InterviewCompetency | undefined): ComparisonKind {
  if (!interview) return 'not_assessed';
  const cvSaysSo = cv.strength !== 'not_evidenced';
  const interviewShowed = !interview.notEnoughEvidence && interview.level !== null && interview.level >= interview.requiredLevel;
  if (cvSaysSo && interviewShowed) return 'agreed';
  if (cvSaysSo && !interviewShowed) return 'interview_found_less';
  if (!cvSaysSo && interviewShowed) return 'interview_went_further';
  return 'neither';
}

function sentenceFor(kind: ComparisonKind, cv: FitCompetencyRead, interview: InterviewCompetency | undefined): string {
  const name = cv.name;
  switch (kind) {
    case 'agreed':
      return `The CV pointed at ${name} and the interview found it, at level ${interview!.level} against a required ${interview!.requiredLevel}.`;
    case 'interview_found_less':
      return interview!.notEnoughEvidence
        ? `The CV evidences ${name}, and this interview did not produce enough evidence to grade it. That is a gap in the conversation, not a finding about the candidate — it is the first thing worth asking about next.`
        : `The CV evidences ${name}, and the interview graded it at level ${interview!.level} against a required ${interview!.requiredLevel}. One conversation is a small sample; read the quotes on both sides before drawing anything from it.`;
    case 'interview_went_further':
      return `The CV said nothing about ${name}, and the interview evidenced it at level ${interview!.level}. CVs leave things out; this is the kind of thing a screen on paper alone would have missed.`;
    case 'neither':
      return `Neither the CV nor the interview has evidence for ${name} yet. It remains an open question rather than a negative.`;
    default:
      return `${name} was not covered in this interview, so there is nothing to set the CV against.`;
  }
}

/**
 * Every competency the role scores, with the CV's reading and the interview's
 * beside it. Sorted so the disagreements are read first, because they are the
 * only rows that change what a person does next.
 */
export function compareFitWithInterview(fit: Fit | null, interview: readonly InterviewCompetency[]): ComparisonRow[] {
  const reads = fit?.competencies ?? [];
  if (reads.length === 0) return [];
  const byId = new Map(interview.map((c) => [c.id, c]));

  return reads
    .map((cv, order) => {
      const found = byId.get(cv.competencyId);
      const kind = kindOf(cv, found);
      return {
        order,
        competencyId: cv.competencyId,
        name: cv.name,
        kind,
        cvStrength: cv.strength,
        cvEvidence: cv.evidence,
        interviewLevel: found?.level ?? null,
        requiredLevel: found?.requiredLevel ?? null,
        interviewEvidence: found?.evidence ?? [],
        sentence: sentenceFor(kind, cv, found),
      };
    })
    // Within a kind, the scorecard's own order. Sorting by name instead would
    // reshuffle the panel whenever a competency was renamed, and would not
    // match the order the same competencies appear in everywhere else.
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.order - b.order)
    .map(({ order: _order, ...row }) => row);
}

/** One line over the comparison: what, if anything, the reader should look at. */
export function comparisonHeadline(rows: readonly ComparisonRow[]): string {
  if (rows.length === 0) return 'There is no CV reading to set against this interview.';
  const less = rows.filter((r) => r.kind === 'interview_found_less').length;
  const more = rows.filter((r) => r.kind === 'interview_went_further').length;
  if (less === 0 && more === 0) return 'The CV and the interview point the same way on every competency.';
  const parts: string[] = [];
  if (less) parts.push(`${less} ${less === 1 ? 'competency the CV pointed at did not come through' : 'competencies the CV pointed at did not come through'} in the interview`);
  if (more) parts.push(`${more} the CV never mentioned ${more === 1 ? 'was' : 'were'} evidenced in the conversation`);
  return `${parts.join(', and ')}. Read the quotes on both sides before concluding anything.`;
}
