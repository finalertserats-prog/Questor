import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { PRESENTATION_MAX_POINTS } from '../src/domain/fitVocabulary.js';
import type { FitScore, RoleSuccessProfile } from '../src/domain/types.js';
import type { TechStackItem } from '../src/domain/techStack.js';
import {
  CAREER_CHANGER_CV, DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, STRONG_CV, WEAK_CV,
} from './fixtures/cvFixtures.js';
import {
  ACADEMIC_CV, CONSULTING_CV, CONTINUOUS_CAREER_CV, EXPLICIT_TERMS_CV, FLUENT_ENGLISH_CV,
  GAPPED_CAREER_CV, KAFKA_GLANCING_CV, KAFKA_OWNED_CV, KEYWORD_STUFFED_CV, LEGACY_TECH_CV,
  LONG_CAREER_TASKS_CV, MARKETING_CV, MARKETING_ROLE, MILITARY_CV, NICE_TO_HAVES_ONLY_CV,
  NON_IDIOMATIC_ENGLISH_CV, NON_US_TITLES_CV, OWN_WORDS_CV, PLAIN_VOICE_A_CV, PLAIN_VOICE_B_CV,
  PLAIN_VOICE_C_CV, PLATFORM_ROLE, PLATFORM_STACK, PRESTIGE_EMPLOYER, PRESTIGE_UNIVERSITY,
  SECOND_PRESTIGE_EMPLOYER, SHORT_CAREER_OWNED_CV, SYNONYM_TERMS_CV, UNKNOWN_EMPLOYER,
  UNKNOWN_UNIVERSITY, UNREADABLE_CV, cvAtEmployer, cvFromUniversity,
} from './fixtures/adversarialCvFixtures.js';

/**
 * The fit scorer, read by someone trying to break it.
 *
 * `fitScoring.test.ts` checks that the scorer does what it was built to do.
 * This file checks the things it was not built for and would be believed about
 * anyway: that a score is a judgement about work and never about a job title, a
 * register of English, a logo, a university, a gap, or a decade of tools.
 *
 * Almost every assertion here is a comparison between two documents rather than
 * a threshold on one. A threshold can be met by a scorer that is wrong in a
 * consistent direction; a pair cannot. Where the point is that something must
 * NOT move the score, the pair is built from the same sentences, so a
 * difference has exactly one cause.
 */

const NOW = new Date('2026-09-23T00:00:00Z');

const score = (cv: string, role: RoleSuccessProfile = DATA_ENGINEER_ROLE, stack: readonly TechStackItem[] = DATA_ENGINEER_STACK): FitScore =>
  computeFitScore({}, cv, role, stack, { now: NOW, scorecardVersion: 4, scorecardStatus: 'approved' }).fit;

const componentScore = (fit: FitScore, key: string): number => fit.components.find((c) => c.key === key)!.score;
const strengthOf = (fit: FitScore, id: string) => fit.competencies!.find((c) => c.competencyId === id)!.strength;
const technology = (fit: FitScore, name: string) => fit.technologies!.find((t) => t.name === name)!;

// =================================================================================
// 1. Matched against the approved scorecard, never against raw job-description text
// =================================================================================

describe('what a CV is matched against', () => {
  /**
   * `Role.sourceText` is the pasted job description: unreviewed, often a
   * copy-paste of a different role, and frequently carrying the exact
   * boilerplate ("must be a self-starter", a salary band, a legal footer) the
   * scorecard exists to strip out. Reading it would mean two candidates for the
   * same role could be measured against different documents depending on when
   * the JD was last edited.
   */
  const fitPath = [
    'src/engines/fitScoring.ts', 'src/engines/fitEvidence.ts', 'src/engines/fitExplain.ts',
    'src/engines/cvFacts.ts', 'src/engines/cvRedaction.ts', 'src/engines/experienceBands.ts',
    'src/services/resumeProfile.ts', 'src/services/scorecards.ts',
  ];

  it.each(fitPath)('never reads the raw job description (%s)', (file) => {
    const source = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(source, `${file} reads Role.sourceText`).not.toMatch(/\bsourceText\b/);
  });

  it('takes its competencies from the scorecard profile it is handed', () => {
    // The role argument IS the approved scorecard's profileJson, parsed. Change
    // the scorecard and the reading changes; nothing else can change it.
    const narrowed: RoleSuccessProfile = { ...DATA_ENGINEER_ROLE, competencies: DATA_ENGINEER_ROLE.competencies.slice(0, 1) };
    expect(score(STRONG_CV, narrowed).competencies!.map((c) => c.competencyId)).toEqual(['c-pipelines']);
  });
});

// =================================================================================
// 2. Every judgement cites a CV line, or says there is no evidence. No silent zeros.
// =================================================================================

describe('every judgement the scorer makes', () => {
  const everyFit = [STRONG_CV, WEAK_CV, CAREER_CHANGER_CV, LEGACY_TECH_CV, UNREADABLE_CV, KEYWORD_STUFFED_CV].map((cv) => score(cv));

  it('either quotes a CV line or says the CV is silent — never both empty', () => {
    for (const fit of everyFit) {
      for (const c of fit.competencies!) {
        if (c.strength === 'not_evidenced') {
          expect(c.score, `${c.name} was not evidenced and still carries a number`).toBeNull();
          expect(c.explanation).toContain('does not mention');
        } else {
          expect(c.evidence.length, `${c.name} is scored ${c.strength} with nothing to quote`).toBeGreaterThan(0);
          expect(c.evidence.every((e) => e.quote.trim().length > 0)).toBe(true);
        }
      }
    }
  });

  it('never scores an unmentioned competency zero', () => {
    for (const fit of everyFit) {
      for (const c of fit.competencies!) expect(c.score === null || c.score > 0).toBe(true);
    }
  });

  it('says the same of a technology: quoted, or plainly absent', () => {
    for (const fit of everyFit) {
      for (const t of fit.technologies!) {
        if (t.strength === 'not_evidenced') expect(t.explanation).toContain('never appears on the CV');
        else expect(t.evidence.length, `${t.name} is ${t.strength} with nothing to quote`).toBeGreaterThan(0);
      }
    }
  });

  it('quotes only lines that are actually on the CV', () => {
    const fit = score(STRONG_CV);
    for (const c of fit.competencies!) {
      for (const e of c.evidence) expect(STRONG_CV, `invented a quote: ${e.quote}`).toContain(e.quote);
    }
  });
});

// =================================================================================
// 3. Recency, duration, depth, scope and ownership
// =================================================================================

describe('using a technology once against owning it for years', () => {
  const glancing = score(KAFKA_GLANCING_CV);
  const owned = score(KAFKA_OWNED_CV);

  it('reads the glancing use as old, and says how old', () => {
    const kafka = technology(glancing, 'Kafka');
    expect(kafka.strength).not.toBe('not_evidenced');
    expect(kafka.recencyYears).toBeGreaterThan(5);
    expect(kafka.explanation).toContain('years ago');
  });

  it('reads the owned platform as current, and says how long', () => {
    const kafka = technology(owned, 'Kafka');
    expect(kafka.recencyYears).toBeLessThanOrEqual(2);
    expect(kafka.monthsUsed).toBeGreaterThanOrEqual(48);
    expect(kafka.explanation).toContain('current or recent work');
    expect(kafka.explanation).toMatch(/for about \d+ years/);
  });

  it('scores the role technologies materially higher for the owner', () => {
    expect(componentScore(owned, 'tech_stack')).toBeGreaterThan(componentScore(glancing, 'tech_stack') + 10);
  });

  it('carries that difference into the overall reading', () => {
    expect(owned.overall).toBeGreaterThan(glancing.overall);
  });

  it('asks the glancing candidate about it rather than writing them off', () => {
    expect(glancing.probes.some((p) => p.startsWith('Probe Kafka:'))).toBe(true);
  });
});

// =================================================================================
// 4. Seniority read from evidence, not from years
// =================================================================================

describe('four years of ownership against twelve years of task work', () => {
  const owned = score(SHORT_CAREER_OWNED_CV);
  const tasks = score(LONG_CAREER_TASKS_CV);

  it('reads scope off the shorter career', () => {
    expect(componentScore(owned, 'experience')).toBeGreaterThan(componentScore(tasks, 'experience') + 15);
  });

  it('names what the longer career does not evidence, rather than calling it junior', () => {
    expect(tasks.experience!.explanation).toContain('does not state');
    expect(tasks.experience!.explanation).toContain('worth asking about');
  });

  it('reads the shorter career as the stronger overall match', () => {
    expect(owned.overall).toBeGreaterThan(tasks.overall);
  });

  it('never reads a number of years anywhere in the scorer', () => {
    // Years are an age proxy and the one input a CV cannot be trusted on: the
    // parser derives them from every four-digit number in the document, which
    // includes the digits in an email address. Nothing here may depend on them.
    const source = readFileSync(join(__dirname, '..', 'src/engines/fitScoring.ts'), 'utf8');
    expect(source).not.toMatch(/totalYears|yearsOfExperience|yearsPrior/);
  });
});

// =================================================================================
// 5. Hard requirements separated from nice-to-haves
// =================================================================================

describe('must-haves against nice-to-haves', () => {
  const fit = score(NICE_TO_HAVES_ONLY_CV);

  it('names the must-have gap in plain words', () => {
    expect(fit.mustHaveGaps).toContain('Pipeline Engineering');
  });

  it('lists the nice-to-haves it did find, separately', () => {
    expect(fit.niceToHavesPresent).toEqual(expect.arrayContaining(['Mentoring', 'Cost Optimisation']));
    expect(fit.niceToHavesPresent).not.toContain('Pipeline Engineering');
  });

  it('refuses to call it a strong match while a must-have is unevidenced', () => {
    expect(fit.band).not.toBe('strong_match');
  });

  it('says how many must-haves were met, and which were not', () => {
    const mustHaves = fit.components.find((c) => c.key === 'must_haves')!;
    expect(mustHaves.explanation).toMatch(/\d+ of \d+ must-have/);
    expect(mustHaves.explanation).toContain('Pipeline Engineering');
  });

  it('separates a required technology gap from a preferred one', () => {
    expect(fit.mustHaveGaps).toContain('Kafka (required technology)');
    expect(fit.mustHaveGaps).not.toContain('Terraform (required technology)');
  });
});

// =================================================================================
// 6. Synonyms, abbreviations, titles, registers, gaps and old tools
// =================================================================================

describe('a CV that spells the role\'s words the way practitioners spell them', () => {
  const explicit = score(EXPLICIT_TERMS_CV, PLATFORM_ROLE, PLATFORM_STACK);
  const synonyms = score(SYNONYM_TERMS_CV, PLATFORM_ROLE, PLATFORM_STACK);

  it('reads RDBMS and relational databases as SQL', () => {
    expect(strengthOf(synonyms, 'p-sql')).toBe(strengthOf(explicit, 'p-sql'));
    expect(strengthOf(synonyms, 'p-sql')).toBe('evidenced');
  });

  it('reads K8s as Kubernetes', () => {
    expect(strengthOf(synonyms, 'p-k8s')).toBe('evidenced');
    expect(technology(synonyms, 'Kubernetes').strength).not.toBe('not_evidenced');
  });

  it('reads ML as machine learning', () => {
    expect(strengthOf(synonyms, 'p-ml')).toBe('evidenced');
  });

  it('does not treat the abbreviated CV as a weaker candidate', () => {
    expect(synonyms.mustHaveGaps).toEqual(explicit.mustHaveGaps);
    expect(synonyms.band).toBe(explicit.band);
  });
});

describe('a CV whose job titles are not American', () => {
  const fit = score(NON_US_TITLES_CV);

  it('is read for the work under the title, not the title', () => {
    expect(strengthOf(fit, 'c-pipelines')).toBe('evidenced');
    expect(strengthOf(fit, 'c-modelling')).toBe('evidenced');
  });

  it('is not banded as unreadable', () => {
    expect(fit.band).not.toBe('not_enough_evidence');
  });
});

describe('a consultant who writes about the client rather than about themselves', () => {
  const fit = score(CONSULTING_CV);

  it('still evidences the work described', () => {
    expect(strengthOf(fit, 'c-pipelines')).toBe('evidenced');
    expect(strengthOf(fit, 'c-modelling')).toBe('evidenced');
  });

  it('is not banded as unreadable', () => {
    expect(fit.band).not.toBe('not_enough_evidence');
  });
});

describe('an academic CV', () => {
  const fit = score(ACADEMIC_CV);

  it('reads the research work as the engineering it is', () => {
    expect(strengthOf(fit, 'c-pipelines')).toBe('evidenced');
  });

  it('is not banded as unreadable because the job titles are academic', () => {
    expect(fit.band).not.toBe('not_enough_evidence');
  });

  /**
   * The real risk on an academic CV is not that a citation is quoted — a paper
   * about unattended ingestion IS weak evidence of unattended ingestion. It is
   * that a forty-item bibliography reads as forty pieces of work, so the score
   * rises with the length of the publication list rather than with what the
   * person did.
   */
  it('does not grow with the length of the bibliography', () => {
    const padded = ACADEMIC_CV.replace(
      'Grants',
      `${Array.from({ length: 12 }, (_, i) => `- Vogt et al., "Unattended ingestion of sensor data, part ${i + 2}", Journal of Environmental Informatics, 20${10 + i}.`).join('\n')}\n\nGrants`,
    );
    expect(score(padded).overall).toBe(fit.overall);
  });

  it('does not read a research grant as a budget the candidate held', () => {
    const scope = fit.components.find((c) => c.key === 'experience')!;
    expect(scope.evidence.join(' ')).not.toContain('340,000');
  });

  it('rests on the work, not on the citations', () => {
    const pipelines = fit.competencies!.find((c) => c.competencyId === 'c-pipelines')!;
    expect(pipelines.evidence[0].section).toBe('experience');
    expect(pipelines.explanation).toContain('in work the CV describes doing');
  });
});

describe('a military CV', () => {
  const fit = score(MILITARY_CV);

  it('reads a section of 12 as a team of 12', () => {
    expect(fit.competencies!.length).toBeGreaterThan(0);
    const scope = fit.components.find((c) => c.key === 'experience')!;
    expect(scope.evidence.join(' ')).toContain('section of 12');
  });

  it('credits the work done in uniform', () => {
    expect(strengthOf(fit, 'c-pipelines')).toBe('evidenced');
    expect(strengthOf(fit, 'c-modelling')).not.toBe('not_evidenced');
  });

  it('is not banded as unreadable', () => {
    expect(fit.band).not.toBe('not_enough_evidence');
  });
});

describe('a career with a three-year gap in it', () => {
  const gapped = score(GAPPED_CAREER_CV);
  const continuous = score(CONTINUOUS_CAREER_CV);

  it('scores exactly the same as the same career without the gap', () => {
    expect(gapped.overall).toBe(continuous.overall);
    expect(gapped.components.map((c) => `${c.key}=${c.score}`)).toEqual(continuous.components.map((c) => `${c.key}=${c.score}`));
  });

  it('shows the gap to a person instead of scoring it', () => {
    expect(gapped.tenureNote).toContain('gap');
    expect(gapped.tenureNote).toContain('not scored');
    expect(continuous.tenureNote ?? '').not.toContain('gap');
  });

  it('publishes employment gaps as a thing it refuses to read', () => {
    expect(gapped.excludedSignals).toContain('employment gaps');
  });
});

describe('a CV built on the previous generation of tools', () => {
  const fit = score(LEGACY_TECH_CV);

  it('still evidences every competency the work demonstrates', () => {
    expect(strengthOf(fit, 'c-pipelines')).toBe('evidenced');
    expect(strengthOf(fit, 'c-modelling')).toBe('evidenced');
    expect(strengthOf(fit, 'c-stakeholder')).toBe('evidenced');
  });

  it('names the missing technologies as technologies, not as a weak candidate', () => {
    expect(fit.mustHaveGaps).toContain('Kafka (required technology)');
    expect(fit.band).not.toBe('not_enough_evidence');
  });

  it('asks about them rather than concluding from them', () => {
    expect(fit.probes.some((p) => p.startsWith('Probe Kafka:'))).toBe(true);
  });

  it('reads better than a CV from an unrelated field', () => {
    expect(fit.overall).toBeGreaterThan(score(WEAK_CV).overall);
  });
});

// =================================================================================
// 7. The false-negative audit
// =================================================================================

describe('strong candidates who write plainly and never sell', () => {
  const plainly = [['A', PLAIN_VOICE_A_CV], ['B', PLAIN_VOICE_B_CV], ['C', PLAIN_VOICE_C_CV]] as const;

  it.each(plainly)('is not filtered out for its phrasing (%s)', (_label, cv) => {
    const fit = score(cv);
    expect(fit.band).not.toBe('not_enough_evidence');
    expect(fit.mustHaveGaps).toEqual([]);
  });

  it.each(plainly)('has its central competency evidenced (%s)', (_label, cv) => {
    expect(strengthOf(score(cv), 'c-pipelines')).toBe('evidenced');
  });

  it('never demands a particular verb before it will believe a sentence', () => {
    // An earlier scorer required an action verb from a fixed list, which is a
    // test of fluent business English rather than of experience.
    const source = readFileSync(join(__dirname, '..', 'src/engines/fitEvidence.ts'), 'utf8');
    expect(source).not.toMatch(/ACTION_VERBS|actionVerb/);
  });
});

// =================================================================================
// 8. Keyword stuffing must not pay
// =================================================================================

describe('a CV that repeats the scorecard\'s own words with nothing behind them', () => {
  const stuffed = score(KEYWORD_STUFFED_CV);
  const described = score(OWN_WORDS_CV);

  it('does not outscore a CV that describes the work in its own words', () => {
    expect(stuffed.overall).toBeLessThan(described.overall);
  });

  it('reads a repeated skills list as a claim, not as evidence', () => {
    for (const c of stuffed.competencies!.filter((c) => c.strength !== 'not_evidenced')) {
      expect(c.strength, `${c.name} reached "evidenced" off a keyword list`).toBe('partial');
      expect(c.explanation).toContain('claimed rather than shown');
    }
  });

  it('reads work described in plain sentences as evidenced', () => {
    expect(strengthOf(described, 'c-pipelines')).toBe('evidenced');
    expect(strengthOf(described, 'c-modelling')).toBe('evidenced');
  });

  it('will not date a technology that only ever appears in a list', () => {
    expect(technology(stuffed, 'Kafka').recencyYears).toBeNull();
    expect(technology(described, 'Kafka').recencyYears).toBe(0);
  });

  it('asks the stuffer for a second example rather than accusing them', () => {
    expect(stuffed.probes.some((p) => p.includes('Ask for a second example'))).toBe(true);
  });
});

// =================================================================================
// 9. Bias controls
// =================================================================================

describe('the employer on the CV', () => {
  const unknown = score(cvAtEmployer(UNKNOWN_EMPLOYER));

  it.each([PRESTIGE_EMPLOYER, SECOND_PRESTIGE_EMPLOYER])('does not move the score (%s)', (employer) => {
    const prestigious = score(cvAtEmployer(employer));
    expect(prestigious.overall).toBe(unknown.overall);
    expect(prestigious.components.map((c) => `${c.key}=${c.score}`)).toEqual(unknown.components.map((c) => `${c.key}=${c.score}`));
    expect(prestigious.competencies!.map((c) => c.strength)).toEqual(unknown.competencies!.map((c) => c.strength));
  });
});

describe('the university on the CV', () => {
  const prestigious = score(cvFromUniversity(PRESTIGE_UNIVERSITY, '2014'));
  const unknown = score(cvFromUniversity(UNKNOWN_UNIVERSITY, '1996'));

  it('does not move the score, nor does the year of the degree', () => {
    expect(prestigious.overall).toBe(unknown.overall);
    expect(prestigious.components.map((c) => `${c.key}=${c.score}`)).toEqual(unknown.components.map((c) => `${c.key}=${c.score}`));
  });

  it('is removed from the text before scoring, and reported as removed', () => {
    expect(prestigious.redaction!.kinds).toContain('education_provenance');
    const quoted = [
      ...prestigious.competencies!.flatMap((c) => c.evidence.map((e) => e.quote)),
      ...prestigious.components.flatMap((c) => c.evidence),
    ].join(' ');
    expect(quoted).not.toContain(PRESTIGE_UNIVERSITY);
    expect(quoted).not.toContain('2014');
  });

  it('publishes school prestige as a thing it refuses to read', () => {
    expect(prestigious.excludedSignals).toContain('school prestige');
  });
});

describe('the same career written in fluent and in non-idiomatic English', () => {
  const fluent = score(FLUENT_ENGLISH_CV);
  const nonIdiomatic = score(NON_IDIOMATIC_ENGLISH_CV);

  it('scores identically — not within a tolerance, identically', () => {
    expect(nonIdiomatic.overall).toBe(fluent.overall);
  });

  it('reads the same competencies off both', () => {
    expect(nonIdiomatic.competencies!.map((c) => `${c.competencyId}=${c.strength}`))
      .toEqual(fluent.competencies!.map((c) => `${c.competencyId}=${c.strength}`));
  });

  it('scores every component the same', () => {
    expect(nonIdiomatic.components.map((c) => `${c.key}=${c.score}`)).toEqual(fluent.components.map((c) => `${c.key}=${c.score}`));
  });

  it('lands in the same band', () => {
    expect(nonIdiomatic.band).toBe(fluent.band);
  });
});

describe('the bound on how far wording can move a score', () => {
  /**
   * What PRESENTATION_MAX_POINTS actually does, checked rather than asserted in
   * a comment: it is the WEIGHT of the one component whose score depends on the
   * words a CV happens to use — the overlap between the CV and the role's own
   * statement of its outcomes. Every other component reads a fact: a competency
   * evidenced or not, a technology dated or not, a figure stated or not.
   */
  const fit = score(STRONG_CV);
  const wording = fit.components.find((c) => c.key === 'outcomes')!;

  it('is the weight of the one wording-sensitive component', () => {
    expect(wording.weight).toBe(PRESENTATION_MAX_POINTS / 100);
  });

  it('is the whole of that component, so it cannot be exceeded', () => {
    // Even a CV that echoed every one of the role's words and one that echoed
    // none of them differ by at most this component's full contribution.
    expect(wording.score * wording.weight).toBeLessThanOrEqual(PRESENTATION_MAX_POINTS);
  });

  it('says so on the panel, in the component\'s own rule', () => {
    expect(wording.rule).toContain(`${PRESENTATION_MAX_POINTS} points out of a hundred`);
  });

  it('keeps the same cap on a role with no technology list, where there is slack to give away', () => {
    const noStack = score(STRONG_CV, DATA_ENGINEER_ROLE, []);
    expect(noStack.components.find((c) => c.key === 'outcomes')!.weight).toBe(PRESENTATION_MAX_POINTS / 100);
  });

  it('leaves the weights adding up to a hundred, so the arithmetic on screen is checkable', () => {
    const total = fit.components.reduce((a, c) => a + c.weight, 0);
    expect(Math.round(total * 100)).toBe(100);
  });
});

// =================================================================================
// 10. Uncertainty is a state, not a low score
// =================================================================================

describe('a CV the scorer cannot judge', () => {
  const fit = score(UNREADABLE_CV);

  it('is banded as not enough evidence rather than as a poor match', () => {
    expect(fit.band).toBe('not_enough_evidence');
  });

  it('says the document is thin, not that the candidate is', () => {
    expect(fit.meaning).toContain('too little');
    expect(fit.meaning).not.toMatch(/weak|poor|unsuitable/i);
  });

  it('is reached by coverage rather than by the number being low', () => {
    // The band is decided before the number: a CV can score respectably on the
    // components it touches and still be unreadable against the scorecard.
    expect(fit.coverage!).toBeLessThan(0.35);
  });

  it('is less confident, rather than making the candidate look worse', () => {
    expect(fit.confidence).toBeLessThan(score(STRONG_CV).confidence);
  });

  it('is the band the browser hangs "needs a person to look" off', () => {
    const panel = readFileSync(join(__dirname, '..', '..', 'web', 'src', 'components', 'fit', 'FitPanel.tsx'), 'utf8');
    expect(panel).toContain("bandOf(fit) === 'not_enough_evidence'");
    expect(panel).toContain('FIT_NEEDS_A_PERSON');
  });

  it('never borrows a decision word for any of it', () => {
    const said = [fit.meaning ?? '', ...fit.components.map((c) => c.explanation ?? ''), ...fit.probes].join(' ').toLowerCase();
    for (const word of ['proceed', 'do not progress', 'reject', 'shortlist']) expect(said).not.toContain(word);
  });
});

// =================================================================================
// A vocabulary gap that is not this lane's to close
// =================================================================================

describe('a senior marketing CV against a marketing role', () => {
  const fit = score(MARKETING_CV, MARKETING_ROLE, []);

  /**
   * The competency reading works, because it is built from the SCORECARD's own
   * vocabulary and the CV describes the work.
   */
  it('evidences the competencies the work demonstrates', () => {
    expect(strengthOf(fit, 'm-demand')).toBe('evidenced');
    expect(strengthOf(fit, 'm-analytics')).toBe('evidenced');
  });

  it('is not filtered out for being a non-engineering CV', () => {
    expect(fit.band).not.toBe('not_enough_evidence');
  });

  /**
   * What does NOT work, recorded here rather than fixed: `domain/techStack.ts`
   * `TECHNOLOGIES` is an engineering catalogue. It has no entry for Eloqua,
   * Google Analytics, SEO, A/B testing or ABM, so a marketing role's technology
   * list can only ever be matched line-by-line with no dates attached — the
   * reading says "named on the CV, but never inside a dated job" for tools this
   * person has used daily for a decade.
   *
   * That catalogue is owned by the CV-parsing lane, and widening it there fixes
   * it for the parser and the scorer at once. This test pins the current
   * behaviour so the day it changes, it changes visibly.
   */
  it('cannot date a marketing tool, because the technology catalogue is engineering-only', () => {
    const marketingStack: TechStackItem[] = [{ name: 'Google Analytics', category: 'tooling', level: 'strong', required: true }];
    const dated = score(MARKETING_CV, MARKETING_ROLE, marketingStack);
    const ga = technology(dated, 'Google Analytics');
    expect(ga.strength).not.toBe('not_evidenced');
    expect(ga.recencyYears).toBeNull();
    expect(ga.explanation).toContain('never inside a dated job');
  });
});
