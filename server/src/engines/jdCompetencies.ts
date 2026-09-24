import type { Competency, Proficiency } from '../domain/types.js';
import { baselineCompetencies, extractableCompetencies, resolveCanonical } from '../domain/taxonomy/index.js';
import type { CanonicalCompetency } from '../domain/taxonomy/types.js';
import { contributingLines, maskCollaborationObjects, sectionWeight, type JdLine, type JdSectionKind } from './jdSections.js';
import type { BandId } from './experienceBands.js';

/**
 * Job description in, proposed competencies out — each one able to say which
 * line of the advert put it there.
 *
 * The product already refuses to assert anything about a candidate it cannot
 * quote: interview evidence carries its transcript span, a CV fact carries its
 * source line. A competency is a stronger claim than either, because it is
 * what every candidate for the role will be measured against, and until now it
 * carried nothing. It does now: no span, no competency.
 *
 * The only exception is the platform's four baseline competencies, and they
 * are not an exception so much as an honest label — they do not come from the
 * advert, they are marked `baseline`, and the screen says so.
 */

export interface CompetencySpan {
  /** The JD line, verbatim, minus its bullet. */
  readonly text: string;
  /** 1-based line number in the original text. */
  readonly line: number;
  readonly section: JdSectionKind;
}

export type ProposalOrigin = 'jd' | 'baseline';

export interface ProposedCompetency {
  /** The canonical key, or null for something real that the vocabulary does not name. */
  readonly key: string | null;
  readonly name: string;
  readonly category: Competency['category'];
  readonly definition: string;
  readonly indicators: readonly string[];
  readonly classification: Competency['classification'];
  readonly requiredLevel: Proficiency;
  readonly targetLevel: Proficiency;
  readonly weight: number;
  readonly confidence: number;
  readonly spans: readonly CompetencySpan[];
  readonly origin: ProposalOrigin;
  /** Shown as uncertain rather than quietly included. */
  readonly lowConfidence: boolean;
  /** Why this was proposed, and how its weight and level were arrived at. */
  readonly rationale: string;
}

export interface ProposeOptions {
  readonly title?: string;
  readonly band?: BandId;
  /** Seniority word from the advert, used when no band was chosen. */
  readonly level?: string;
}

/** Below this nothing is proposed at all: a single glancing mention is not a requirement. */
export const MIN_CONFIDENCE_TO_PROPOSE = 0.3;
/** At or below this the proposal is shown as uncertain. */
export const LOW_CONFIDENCE = 0.5;

/** "must have", "deep", "expert" — the advert insisting rather than mentioning. */
const INSISTENCE = /\b(must(\s+have)?|required|essential|mandator(y|ily)|strong|deep|expert|extensive|proven|significant|substantial|advanced|solid track record)\b/i;
/** "nice to have", "exposure to" — the advert explicitly not insisting. */
const SOFTENER = /\b(nice to have|preferred|desirable|bonus|a plus|exposure to|familiarity with|some experience|awareness of|willingness to learn|an advantage)\b/i;
/** Depth words that raise the level asked for rather than merely the weight. */
const DEPTH = /\b(deep|expert|extensive|advanced|mastery|specialis(t|ed)|specializ(ed)|architect|lead(ing)? the design)\b/i;

const BAND_BASE_LEVEL: Readonly<Record<BandId, number>> = {
  emerging: 1,
  developing: 2,
  established: 2,
  senior: 3,
  principal: 4,
  executive: 4,
};

function bandFrom(opts: ProposeOptions): BandId {
  if (opts.band) return opts.band;
  const text = `${opts.level ?? ''} ${opts.title ?? ''}`;
  if (/\b(principal|staff|distinguished|head of|director|vp\b|chief)\b/i.test(text)) return 'principal';
  if (/\b(senior|sr\.?|lead)\b/i.test(text)) return 'senior';
  if (/\b(junior|jr\.?|graduate|entry|intern|associate|trainee|apprentice)\b/i.test(text)) return 'emerging';
  return 'established';
}

interface Gathered {
  readonly canonical: CanonicalCompetency;
  readonly spans: CompetencySpan[];
}

/**
 * Read the advert once, and collect the lines that evidence each competency.
 *
 * Cues are tried against the *masked* line, so "partner with product teams"
 * offers no evidence of Product Management, while the span that is kept and
 * shown is the line as the advert actually wrote it. The human reads the real
 * sentence; the matcher reads the one with other people's disciplines removed.
 */
function gather(sourceText: string): Map<string, Gathered> {
  const lines: JdLine[] = contributingLines(sourceText);
  const found = new Map<string, Gathered>();
  for (const line of lines) {
    const masked = maskCollaborationObjects(line.text);
    for (const canonical of extractableCompetencies()) {
      if (!canonical.cues.some((re) => re.test(masked))) continue;
      const entry = found.get(canonical.key) ?? { canonical, spans: [] };
      // The same requirement repeated on one line is one span, not two.
      if (!entry.spans.some((s) => s.line === line.line)) {
        entry.spans.push({ text: line.text, line: line.line, section: line.section });
      }
      found.set(canonical.key, entry);
    }
  }
  return found;
}

/**
 * A broad competency has to earn a line of its own.
 *
 * "Build and operate batch and streaming pipelines using Python, Airflow and
 * Spark" evidences Data Engineering & Pipelines, and — through the bare word
 * Python — Software Engineering as well. Proposing both measures the candidate
 * twice on one sentence, and buries the requirement the advert actually made
 * under a generic one it did not.
 *
 * So a `general` competency survives only on a line that no more specific
 * competency already claims, and not from the nice-to-haves: an umbrella named
 * once as a bonus is not what this job is for. A backend advert reading
 * "Strong Java, design patterns and code review" keeps Software Engineering,
 * because that line is its own.
 */
function earnedTheirPlace(gathered: readonly Gathered[]): Gathered[] {
  const specificLines = new Set(
    gathered.filter((g) => !g.canonical.general).flatMap((g) => g.spans.map((s) => s.line)),
  );
  return gathered.filter(({ canonical, spans }) => {
    if (!canonical.general) return true;
    return spans.some((s) => !specificLines.has(s.line) && s.section !== 'nice_to_have');
  });
}

/**
 * How hard the advert is pushing for this.
 *
 * A requirement stated three times in the requirements section outweighs one
 * mentioned in passing halfway down the responsibilities, and that difference
 * is what the weight is for. Uniform weights told a candidate that everything
 * mattered equally, which no job has ever been true of.
 */
function emphasisOf(spans: readonly CompetencySpan[]): number {
  return spans.reduce((total, span) => {
    const insists = INSISTENCE.test(span.text) ? 1.35 : 1;
    const softens = SOFTENER.test(span.text) ? 0.6 : 1;
    return total + sectionWeight(span.section) * insists * softens;
  }, 0);
}

function classificationOf(spans: readonly CompetencySpan[]): Competency['classification'] {
  const allNiceToHave = spans.every((s) => s.section === 'nice_to_have' || SOFTENER.test(s.text));
  if (allNiceToHave) return 'preferred';
  if (spans.some((s) => s.section === 'requirements' || INSISTENCE.test(s.text))) return 'essential';
  // Named once, in passing, among the duties. Real, but not what the hire
  // turns on — and calling it essential is how a must-pass list fills up with
  // things nobody meant to gate on.
  return spans.length >= 2 ? 'essential' : 'preferred';
}

function levelOf(spans: readonly CompetencySpan[], band: BandId, classification: Competency['classification']): Proficiency {
  let level = BAND_BASE_LEVEL[band];
  if (spans.some((s) => DEPTH.test(s.text))) level += 1;
  if (classification === 'preferred') level -= 1;
  return clampLevel(level);
}

function confidenceOf(spans: readonly CompetencySpan[]): number {
  const strongest = Math.max(...spans.map((s) => sectionWeight(s.section)));
  const repetition = Math.min(0.2, (spans.length - 1) * 0.1);
  const insisted = spans.some((s) => INSISTENCE.test(s.text)) ? 0.12 : 0;
  const softened = spans.some((s) => SOFTENER.test(s.text)) ? -0.08 : 0;
  return round(Math.max(0.2, Math.min(0.95, strongest * 0.7 + repetition + insisted + softened)));
}

const SECTION_WORDS: Readonly<Record<JdSectionKind, string>> = {
  requirements: 'the requirements',
  responsibilities: 'the responsibilities',
  nice_to_have: 'the nice-to-haves',
  role_summary: 'the role summary',
  unknown: 'the job description',
  company: 'the company description',
  benefits: 'the benefits',
  boilerplate: 'the boilerplate',
};

function rationaleFor(
  name: string,
  spans: readonly CompetencySpan[],
  classification: Competency['classification'],
  level: Proficiency,
  band: BandId,
): string {
  const where = SECTION_WORDS[spans[0].section];
  const parts = [`Proposed from ${where}: "${truncate(spans[0].text, 140)}".`];
  if (spans.length > 1) parts.push(`The advert asks for it on ${spans.length} lines.`);
  if (spans.some((s) => INSISTENCE.test(s.text))) parts.push('It is stated as a requirement rather than mentioned.');
  if (classification === 'preferred') parts.push('Filed as preferred because the advert does not insist on it.');
  const deeper = spans.some((s) => DEPTH.test(s.text));
  parts.push(`Level ${level} for a ${band} role${deeper ? ' where the advert asks for depth' : ''}.`);
  return parts.join(' ');
}

/**
 * Normalise scored weights to sum to one, in proportion to how hard the advert
 * pushed for each. Baseline competencies take a fixed modest share, because
 * the advert said nothing about them and inventing emphasis for them would be
 * a fiction.
 */
const BASELINE_EMPHASIS = 0.5;

function normalise(
  entries: ReadonlyArray<{ readonly proposal: ProposedCompetency; readonly emphasis: number }>,
): ProposedCompetency[] {
  const scored = entries.filter((e) => e.proposal.classification !== 'non_scoring');
  const total = scored.reduce((a, e) => a + e.emphasis, 0) || 1;
  return entries.map(({ proposal, emphasis }) => ({
    ...proposal,
    weight: proposal.classification === 'non_scoring' ? 0 : round(emphasis / total),
  }));
}

/**
 * The competencies a job description supports, each carrying the lines that
 * support it, plus the platform's four baselines marked as what they are.
 */
export function proposeFromJd(sourceText: string, opts: ProposeOptions = {}): ProposedCompetency[] {
  const band = bandFrom(opts);
  const gathered = earnedTheirPlace([...gather(sourceText).values()]);

  const fromJd = gathered.map(({ canonical, spans }) => {
    const classification = classificationOf(spans);
    const requiredLevel = levelOf(spans, band, classification);
    const confidence = confidenceOf(spans);
    const proposal: ProposedCompetency = {
      key: canonical.key,
      name: canonical.name,
      category: canonical.category,
      definition: canonical.definition,
      indicators: canonical.indicators,
      classification,
      requiredLevel,
      targetLevel: clampLevel(requiredLevel + 1),
      weight: 0,
      confidence,
      spans,
      origin: 'jd',
      lowConfidence: confidence <= LOW_CONFIDENCE,
      rationale: rationaleFor(canonical.name, spans, classification, requiredLevel, band),
    };
    return { proposal, emphasis: emphasisOf(spans) };
  }).filter((e) => e.proposal.confidence >= MIN_CONFIDENCE_TO_PROPOSE);

  const baseline = baselineCompetencies().map((canonical) => {
    const requiredLevel = clampLevel(BAND_BASE_LEVEL[band]);
    const proposal: ProposedCompetency = {
      key: canonical.key,
      name: canonical.name,
      category: canonical.category,
      definition: canonical.definition,
      indicators: canonical.indicators,
      classification: canonical.key === 'ownership & impact' ? 'preferred' : 'essential',
      requiredLevel,
      targetLevel: clampLevel(requiredLevel + 1),
      weight: 0,
      confidence: 0.9,
      spans: [],
      origin: 'baseline' as const,
      lowConfidence: false,
      rationale: 'Asked on every role by the platform, not taken from this advert. Remove it if this job genuinely does not need it.',
    };
    return { proposal, emphasis: BASELINE_EMPHASIS };
  });

  return normalise([...fromJd, ...baseline]);
}

/**
 * Does this quote actually appear in the job description?
 *
 * Used on anything a model claims as a citation. A model that invents a
 * plausible-sounding JD line would otherwise produce a competency that looks
 * perfectly evidenced and is not, which is worse than one with no span at all:
 * the first survives review, the second does not.
 */
export function verifySpan(sourceText: string, quote: string): boolean {
  const needle = flatten(quote);
  if (needle.length < 8) return false;
  return flatten(sourceText).includes(needle);
}

function flatten(text: string): string {
  return text.replace(/\r/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The span a quote came from, when it can be found, so a model's citation gets a line number. */
export function locateSpan(sourceText: string, quote: string): CompetencySpan | null {
  const needle = flatten(quote);
  if (needle.length < 8) return null;
  for (const line of contributingLines(sourceText)) {
    if (flatten(line.text).includes(needle) || needle.includes(flatten(line.text))) {
      return { text: line.text, line: line.line, section: line.section };
    }
  }
  return null;
}

/** The canonical entry a model-supplied name means, so near-duplicates collapse. */
export function canonicaliseName(name: string): CanonicalCompetency | null {
  return resolveCanonical(name);
}

function clampLevel(value: number): Proficiency {
  return Math.max(1, Math.min(5, Math.round(value))) as Proficiency;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
