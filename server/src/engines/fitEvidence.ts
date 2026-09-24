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
 *
 * The second group is the one that cost a real candidate a must-have. A
 * competency called "Pipeline Engineering" put `engineering` in its name terms,
 * where a single occurrence is evidence — and the line it matched was the job
 * heading "Engineering Manager, Aldbury Software". The competency was then
 * recorded as evidenced by a JOB TITLE, on a CV whose work described none of
 * it. Craft nouns name a profession, not a skill: they cannot carry a
 * competency on their own, in either direction.
 */
const WEAK_TERMS = new Set([
  'data', 'design', 'system', 'systems', 'process', 'business', 'product', 'service', 'services',
  'project', 'projects', 'client', 'customer', 'delivery', 'management', 'manage', 'analysis',
  'report', 'reports', 'reporting',
  'engineer', 'engineers', 'engineering', 'developer', 'developers', 'development',
  'operations', 'technology', 'technologies', 'technical', 'software', 'solutions',
  'specialist', 'consultant', 'consulting', 'associate', 'senior', 'junior', 'principal',
]);

/**
 * Spellings of one idea, so a CV is not marked down for writing it the way
 * practitioners write it.
 *
 * A DBA of twenty years writes "RDBMS" and "relational databases"; a scorecard
 * competency called "SQL Development" reduced to the terms `development` and
 * `sql`, and matched neither. The same CV writes "K8s" for Kubernetes and "ML"
 * for machine learning. None of that is obscure or evasive — it is the register
 * of the trade, and a matcher that only speaks the recruiter's register scores
 * the register rather than the experience.
 *
 * Kept deliberately short, and to pairs that are genuinely interchangeable in a
 * CV. This is not a thesaurus: "led" and "managed" mean different things, and a
 * scorer that flattened them would be inventing evidence rather than reading
 * it. Every entry here is one thing with two names.
 */
const EQUIVALENCE_GROUPS: ReadonlyArray<readonly string[]> = [
  ['sql', 'rdbms', 'relational database', 'relational databases', 't-sql', 'pl/sql'],
  ['kubernetes', 'k8s'],
  ['machine learning', 'ml'],
  ['postgresql', 'postgres'],
  ['javascript', 'js'],
  ['continuous integration', 'ci/cd', 'cicd'],
  ['infrastructure as code', 'iac'],
  ['natural language processing', 'nlp'],
  ['user experience', 'ux'],
  ['business intelligence', 'power bi'],
  ['extract transform load', 'etl'],
  ['quality assurance', 'qa'],
  ['test driven development', 'tdd'],
  ['search engine optimisation', 'search engine optimization', 'seo'],
  ['account based marketing', 'abm'],
  ['application programming interface', 'api'],
];

/**
 * Every spelling of a term, itself included.
 *
 * Matched as whole strings rather than word by word, because half of these are
 * phrases: "machine learning" is one idea spelled with a space in it.
 */
export function spellingsOf(term: string): readonly string[] {
  const lower = term.toLowerCase();
  const group = EQUIVALENCE_GROUPS.find((g) => g.includes(lower));
  return group ? [term, ...group.filter((t) => t !== lower)] : [term];
}

/** The other spellings of anything the given text already says. */
function equivalentTermsIn(text: string): string[] {
  const out: string[] = [];
  for (const group of EQUIVALENCE_GROUPS) {
    if (group.some((t) => termMatcher(t).test(text))) out.push(...group);
  }
  return out;
}

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
  const nameTerms = new Set<string>(
    [...contentWords(competency.name), ...acronyms(competency.name), ...equivalentTermsIn(competency.name)]
      .filter((w) => !WEAK_TERMS.has(w)),
  );

  const supportTerms = new Set<string>();
  const addSupport = (word: string) => {
    if (supportTerms.size < MAX_TERMS && !nameTerms.has(word)) supportTerms.add(word);
  };
  const prose = [competency.definition ?? '', ...(competency.indicators ?? [])].join(' ');
  for (const word of contentWords(competency.definition ?? '')) addSupport(word);
  for (const word of acronyms(competency.definition ?? '')) addSupport(word);
  for (const indicator of competency.indicators ?? []) {
    for (const word of contentWords(indicator)) addSupport(word);
    for (const word of acronyms(indicator)) addSupport(word);
  }
  for (const word of equivalentTermsIn(prose)) addSupport(word);

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

    const tech = vocab.technologies.find((t) => spellingsOf(t).some((s) => mentionsTechnology(line.text, s)));
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
 *
 * What changed after the adversarial pass: repetition inside a CLAIM section no
 * longer counts. The rule used to be "two lines anywhere, or one line in
 * experience", and two lines anywhere includes two lines of a "Core
 * Competencies" block that pastes the scorecard's own words back. Writing a
 * competency name down twice was therefore worth more than writing it down
 * once, which is a reward for stuffing and nothing else. A list is a claim
 * however many times it is printed; the count only means something outside the
 * sections whose whole purpose is to list.
 */
const CLAIM_SECTIONS = new Set(['skills', 'certifications']);

export function strengthOf(hits: readonly EvidenceHit[]): FitStrength {
  if (hits.length === 0) return 'not_evidenced';
  const doing = hits.some((h) => h.evidence.section === 'experience' || h.evidence.section === 'projects');
  if (doing) return 'evidenced';
  const beyondAClaim = hits.filter((h) => !CLAIM_SECTIONS.has(h.evidence.section));
  if (beyondAClaim.length >= 2) return 'evidenced';
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
    // The catalogued reading first, under any of the technology's spellings: a
    // CV that writes "RDBMS" throughout has still been using SQL since 2004,
    // and the dates behind that belong to the reading.
    const use = spellingsOf(item.name).map((s) => known.get(s.toLowerCase())).find(Boolean);
    if (use) {
      return {
        item,
        strength: strengthFromUse(use),
        recencyYears: use.recencyYears ?? null,
        monthsUsed: use.monthsUsed ?? null,
        evidence: [...use.evidence],
      };
    }
    const spellings = spellingsOf(item.name);
    const hits = lines.filter((l) => spellings.some((s) => mentionsTechnology(l.text, s))).slice(0, 3);
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
