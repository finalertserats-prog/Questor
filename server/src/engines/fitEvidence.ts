import { mentionsTechnology, stackItemsFor, type TechStackItem } from '../domain/techStack.js';
import type { Competency } from '../domain/types.js';
import type { CvEvidence, CvFacts, CvLine, CvTechnologyUse } from '../domain/cvFacts.js';
import type { FitStrength } from '../domain/fitVocabulary.js';

/**
 * Matching a role's competencies and technologies to the lines of a CV.
 *
 * The scorer this replaced looked for the competency's NAME as a substring of a
 * sentence, and split that name on whitespace so that any word over two
 * characters counted on its own. "Data Quality" therefore matched every line
 * containing the word "data", and "Stakeholder Communication" matched nothing
 * at all unless the candidate had written the word "communication" down. The
 * first is a false positive that inflates a score; the second is a false
 * negative that buries a strong candidate who described the work instead of
 * naming it. Both were invisible, because the evidence shown was the matched
 * line, which always looked plausible.
 *
 * What replaces it: a vocabulary per competency drawn from its name, its
 * definition and its observable indicators, with stopwords and single common
 * words removed, and a match that requires either the name as a phrase, a
 * technology the competency is about, or two distinct vocabulary terms in one
 * line. One incidental word is not evidence.
 */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into', 'over', 'their', 'them',
  'able', 'ability', 'across', 'within', 'using', 'used', 'use', 'work', 'working', 'works', 'role', 'roles',
  'team', 'teams', 'other', 'others', 'level', 'levels', 'good', 'strong', 'well', 'more', 'most', 'must',
  'such', 'when', 'where', 'what', 'while', 'they', 'have', 'has', 'had', 'been', 'being', 'will', 'can',
  'new', 'own', 'end', 'per', 'via', 'etc', 'inc', 'ltd', 'year', 'years', 'month', 'months', 'day', 'days',
  'experience', 'experienced', 'knowledge', 'skills', 'skill', 'understanding', 'demonstrated', 'proven',
  'excellent', 'effective', 'effectively', 'high', 'quality', 'support', 'supports', 'supporting',
]);

/**
 * Words so common in work writing that one of them alone means nothing.
 * They still count toward a two-term match, they just cannot carry one alone.
 */
const WEAK_TERMS = new Set(['data', 'design', 'system', 'systems', 'process', 'business', 'product', 'service', 'services', 'project', 'projects', 'client', 'customer', 'delivery', 'management', 'manage', 'analysis', 'report', 'reports', 'reporting']);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z+#.-]{3,}/g) ?? [])
    .map((w) => w.replace(/[.+#-]+$/, ''))
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/**
 * The short words a competency name is often built out of.
 *
 * "SQL & Data Warehousing" reduced to words longer than three characters is
 * "warehousing" and "data" — the acronym that names the actual skill was
 * thrown away for being short, so a CV full of SQL read as having no evidence
 * of SQL. Acronyms are picked out of the ORIGINAL casing, which is what tells
 * SQL, AWS and ML apart from ordinary short words.
 */
function acronyms(text: string): string[] {
  return (text.match(/\b[A-Z][A-Za-z]?[A-Z](?:\/[A-Z]+)?\b/g) ?? [])
    .flatMap((a) => a.split('/'))
    .map((a) => a.toLowerCase())
    .filter((a) => a.length >= 2 && !STOPWORDS.has(a));
}

export interface CompetencyVocabulary {
  /** The competency's own name, matched as a phrase. */
  readonly phrase: string;
  /**
   * Terms from the competency's NAME. A scorecard name is curated and specific,
   * so one of these on a line is evidence on its own.
   */
  readonly nameTerms: ReadonlySet<string>;
  /**
   * Terms from the definition and the indicators. These are prose, so they are
   * noisier, and two are needed before a line counts.
   */
  readonly supportTerms: ReadonlySet<string>;
  /** Technologies this competency is about, from the role's stack. */
  readonly technologies: readonly string[];
}

const MAX_TERMS = 40;

export function vocabularyFor(competency: Competency, stack: readonly TechStackItem[]): CompetencyVocabulary {
  const nameTerms = new Set<string>([...contentWords(competency.name), ...acronyms(competency.name)].filter((w) => !WEAK_TERMS.has(w)));

  const supportTerms = new Set<string>();
  const addSupport = (word: string) => {
    if (supportTerms.size < MAX_TERMS && !nameTerms.has(word)) supportTerms.add(word);
  };
  for (const word of contentWords(competency.definition ?? '')) addSupport(word);
  for (const word of acronyms(competency.definition ?? '')) addSupport(word);
  for (const indicator of competency.indicators ?? []) {
    for (const word of contentWords(indicator)) addSupport(word);
    for (const word of acronyms(indicator)) addSupport(word);
  }

  return {
    phrase: competency.name.trim().toLowerCase(),
    nameTerms,
    supportTerms,
    technologies: stackItemsFor(competency, stack).map((t) => t.name),
  };
}

/**
 * A term on a line, matched at a word boundary rather than as a substring.
 *
 * Substring matching is how "ai" finds "Airflow" and "ml" finds "html". A
 * short term therefore has to be a whole word; a longer one may be a prefix, so
 * "pipeline" still finds "pipelines" and "model" still finds "modelling".
 */
const matchers = new Map<string, RegExp>();

function termMatcher(term: string): RegExp {
  let re = matchers.get(term);
  if (!re) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(term.length <= 3 ? `\\b${escaped}\\b` : `\\b${escaped}`, 'i');
    matchers.set(term, re);
  }
  return re;
}

function present(terms: ReadonlySet<string>, text: string): string[] {
  const found: string[] = [];
  for (const term of terms) {
    if (termMatcher(term).test(text)) found.push(term);
  }
  return found;
}

export type HitKind = 'phrase' | 'technology' | 'terms';

export interface EvidenceHit {
  readonly evidence: CvEvidence;
  readonly kind: HitKind;
  /** Which vocabulary terms the line carried, for the explanation. */
  readonly matched: readonly string[];
}

const MAX_HITS = 4;

/** The CV lines that evidence a competency, strongest first. */
export function hitsFor(vocab: CompetencyVocabulary, lines: readonly CvLine[]): EvidenceHit[] {
  const strong: EvidenceHit[] = [];
  const weak: EvidenceHit[] = [];

  for (const line of lines) {
    if (line.injection) continue;
    const lower = line.text.toLowerCase();
    const evidence: CvEvidence = { line: line.index, quote: line.text, section: line.section };

    const tech = vocab.technologies.find((t) => mentionsTechnology(line.text, t));
    if (tech) {
      strong.push({ evidence, kind: 'technology', matched: [tech] });
      continue;
    }
    if (vocab.phrase.length > 3 && lower.includes(vocab.phrase)) {
      strong.push({ evidence, kind: 'phrase', matched: [vocab.phrase] });
      continue;
    }

    // One term from the competency's own name is enough; the name is curated.
    const named = present(vocab.nameTerms, line.text);
    if (named.length >= 1) {
      strong.push({ evidence, kind: 'terms', matched: named.slice(0, 4) });
      continue;
    }

    // Two from the surrounding prose, at least one not a work-writing filler.
    const support = present(vocab.supportTerms, line.text);
    if (support.length >= 2 && support.some((t) => !WEAK_TERMS.has(t))) {
      (line.section === 'experience' || line.section === 'projects' ? strong : weak)
        .push({ evidence, kind: 'terms', matched: support.slice(0, 4) });
    }
  }
  return [...strong, ...weak].slice(0, MAX_HITS);
}

/**
 * How strongly the CV carries a competency.
 *
 * `evidenced` needs the work described, not the word printed: two supporting
 * lines anywhere, or one line inside the experience or projects section, which
 * is where a CV says what someone actually did. A skills list saying "Kafka,
 * Airflow, Python" is a claim, and a claim reads as `partial` — which is
 * exactly the thing an interview is for.
 *
 * An earlier version also required an action verb from a fixed list, which
 * meant "Built the ingestion" counted and "Spearheaded the ingestion" and "I am
 * building the ingestion" did not. That is a test of fluent business English,
 * not of experience, and it quietly marked down everyone who writes plainly,
 * everyone who writes in consultant-speak, and everyone whose second language
 * this is. The section a line sits in carries the same meaning and carries no
 * opinion about the prose.
 */
export function strengthOf(hits: readonly EvidenceHit[]): FitStrength {
  if (hits.length === 0) return 'not_evidenced';
  const doing = hits.some((h) => h.evidence.section === 'experience' || h.evidence.section === 'projects');
  if (hits.length >= 2 || doing) return 'evidenced';
  return 'partial';
}

export const STRENGTH_SCORE: Readonly<Record<FitStrength, number | null>> = {
  evidenced: 85,
  partial: 60,
  not_evidenced: null,
};

// --- Technologies -------------------------------------------------------------

export interface TechnologyReading {
  readonly item: TechStackItem;
  readonly strength: FitStrength;
  readonly recencyYears: number | null;
  readonly monthsUsed: number | null;
  readonly evidence: CvEvidence[];
}

/** Recency thresholds, in years since the technology last appears in a dated role. */
export const RECENT_YEARS = 2;
export const STALE_YEARS = 5;

/**
 * A role's technologies read off the CV.
 *
 * The catalogued technologies come with dates attached, because the parse tied
 * each mention to the job it sat under. A technology HR typed that the catalog
 * has never heard of is matched on the line directly, which gives evidence
 * without dates — reported as a mention, never dressed up as four years of it.
 */
export function readTechnologies(stack: readonly TechStackItem[], facts: CvFacts): TechnologyReading[] {
  const known = new Map<string, CvTechnologyUse>(facts.technologies.map((t) => [t.name.toLowerCase(), t]));
  const lines = facts.lines.filter((l) => !l.injection);

  return stack.map((item) => {
    const use = known.get(item.name.toLowerCase());
    if (use) {
      return {
        item,
        strength: strengthFromUse(use),
        recencyYears: use.recencyYears ?? null,
        monthsUsed: use.monthsUsed ?? null,
        evidence: [...use.evidence],
      };
    }
    const hits = lines.filter((l) => mentionsTechnology(l.text, item.name)).slice(0, 3);
    return {
      item,
      strength: hits.length === 0 ? 'not_evidenced' : hits.some((h) => h.section === 'experience' || h.section === 'projects') ? 'evidenced' : 'partial',
      recencyYears: null,
      monthsUsed: null,
      evidence: hits.map((l) => ({ line: l.index, quote: l.text, section: l.section })),
    };
  });
}

function strengthFromUse(use: CvTechnologyUse): FitStrength {
  const inWork = use.evidence.some((e) => e.section === 'experience' || e.section === 'projects');
  if (inWork && (use.monthsUsed ?? 0) > 0) return 'evidenced';
  if (inWork) return 'evidenced';
  return 'partial';
}
