import type {
  Competency, FitCompetencyRead, FitProbe, FitScore, FitScoreComponent, FitTechnologyRead,
  NormalizedProfile, RoleSuccessProfile,
} from '../domain/types.js';
import { techStackNames, type TechStackItem } from '../domain/techStack.js';
import { EXCLUDED_SIGNALS, emptyFacts, type CvEvidence, type CvFacts } from '../domain/cvFacts.js';
import {
  FIT_BAND_MEANINGS, PRESENTATION_MAX_POINTS, UNEVIDENCED_NEUTRAL_SCORE, fitBandOf,
  type FitStrength,
} from '../domain/fitVocabulary.js';
import { bandForRoleSeniority } from './bandCalibration.js';
import { extractCvFacts } from './cvFacts.js';
import { RECENT_YEARS, STALE_YEARS, STRENGTH_SCORE, hitsFor, readTechnologies, strengthOf, vocabularyFor } from './fitEvidence.js';
import { buildProbes, competencySentence, experienceSentence, technologySentence } from './fitExplain.js';

/**
 * Pre-interview fit: what a CV evidences about THIS role, with the line behind
 * every part of it.
 *
 * The rules this scorer is built to keep, in the order they matter.
 *
 * - Nothing is scored that cannot be quoted. Every component carries the CV
 *   lines it was built from, and a component with no evidence says so.
 * - Silence is silence. A competency the CV never mentions is reported as not
 *   evidenced and carried at a stated neutral, not scored zero. A CV that does
 *   not mention stakeholder management is not proof someone cannot do it.
 * - Protected characteristics cannot reach a number. They are removed from the
 *   text before this module runs (engines/cvRedaction.ts), and every signal
 *   below is a match against the ROLE's own vocabulary — so a candidate's name,
 *   age, nationality or university cannot contribute even incidentally.
 * - Polish is bounded. No component reads CV length, prose quality or word
 *   count; the one presentation-adjacent signal is capped at
 *   PRESENTATION_MAX_POINTS. Evidence, not polish.
 * - It is never a decision. The output uses the fit vocabulary
 *   (domain/fitVocabulary.ts), which deliberately shares no word with the
 *   interview verdict.
 */

/** Bumping this makes every stored fit read as scored by an older engine. */
export const FIT_ENGINE_VERSION = 'fit-v2';

export interface FitResult {
  fit: FitScore;
  /** Kept for the evidence graph, which stores one node per competency. */
  perCompetency: Array<{ competencyId: string; name: string; evidence: string[]; strength: 'explicit' | 'inferred' | 'missing' }>;
}

export interface ScoreFitOptions {
  readonly facts?: CvFacts;
  readonly scorecardVersion?: number | null;
  readonly now?: Date;
}

const LEGACY_STRENGTH: Readonly<Record<FitStrength, 'explicit' | 'inferred' | 'missing'>> = {
  evidenced: 'explicit', partial: 'inferred', not_evidenced: 'missing',
};

/**
 * Score a CV against a role.
 *
 * `profile` is only a fallback source of text for the rare caller that has a
 * parsed profile and no raw CV; the facts are read from `rawText` whenever
 * there is any.
 */
export function computeFitScore(
  profile: NormalizedProfile | Record<string, never>,
  rawText: string,
  role: RoleSuccessProfile,
  techStack: readonly TechStackItem[] = [],
  opts: ScoreFitOptions = {},
): FitResult {
  const facts = opts.facts ?? extractCvFacts(rawText?.trim() ? rawText : textFromProfile(profile), { today: opts.now });
  return scoreFit(facts, role, techStack, opts);
}

export function scoreFit(facts: CvFacts, role: RoleSuccessProfile, techStack: readonly TechStackItem[] = [], opts: ScoreFitOptions = {}): FitResult {
  const now = opts.now ?? new Date();
  const lines = facts.lines.filter((l) => !l.injection);
  const competencies = (role.competencies ?? []).filter((c) => c.retired !== true && c.classification !== 'non_scoring');
  const mustHaveIds = new Set(role.scoringRules?.mustPassCompetencyIds ?? []);
  const roleBand = bandForRoleSeniority(role.seniority ?? '');

  // ---- Competencies ---------------------------------------------------------
  const reads: FitCompetencyRead[] = competencies.map((c) => {
    const hits = hitsFor(vocabularyFor(c, techStack), lines);
    const strength = strengthOf(hits);
    return {
      competencyId: c.id,
      name: c.name,
      classification: c.classification,
      mustHave: mustHaveIds.has(c.id),
      strength,
      score: STRENGTH_SCORE[strength],
      evidence: hits.map((h) => h.evidence),
      explanation: competencySentence(c.name, strength, hits),
    };
  });

  const weightOf = (c: Competency) => (c.weight > 0 ? c.weight : 1 / Math.max(1, competencies.length));
  const totalWeight = competencies.reduce((a, c) => a + weightOf(c), 0) || 1;
  const evidencedWeight = competencies.reduce(
    (a, c, i) => a + (reads[i].strength === 'not_evidenced' ? 0 : weightOf(c)), 0,
  );
  const coverage = round2(evidencedWeight / totalWeight);
  const competencyScore = competencies.length === 0
    ? 50
    : Math.round(competencies.reduce((a, c, i) => a + (reads[i].score ?? UNEVIDENCED_NEUTRAL_SCORE) * weightOf(c), 0) / totalWeight);

  // ---- Technologies ---------------------------------------------------------
  const readings = readTechnologies(techStack, facts);
  const technologies: FitTechnologyRead[] = readings.map((r) => ({
    name: r.item.name,
    required: r.item.required,
    level: r.item.level,
    strength: r.strength,
    recencyYears: r.recencyYears,
    monthsUsed: r.monthsUsed,
    evidence: r.evidence,
    explanation: technologySentence(r, roleBand.id),
  }));
  const stackScore = scoreStack(readings, roleBand.abstraction);

  // ---- Must-haves -----------------------------------------------------------
  const mustHaveCompetencyGaps = reads.filter((r) => r.mustHave && r.strength === 'not_evidenced');
  const mustHaveTechGaps = readings.filter((r) => r.item.required && (r.item.level === 'strong' || r.item.level === 'expert') && r.strength === 'not_evidenced');
  const mustHaveCount = reads.filter((r) => r.mustHave).length + readings.filter((r) => r.item.required && (r.item.level === 'strong' || r.item.level === 'expert')).length;
  const mustHaveGapCount = mustHaveCompetencyGaps.length + mustHaveTechGaps.length;
  const mustHaveScore = mustHaveCount === 0 ? 65 : Math.round(((mustHaveCount - mustHaveGapCount) / mustHaveCount) * 100);

  // ---- Outcomes -------------------------------------------------------------
  const outcome = scoreOutcomes(role, facts);

  // ---- Experience against the role's band -----------------------------------
  const experience = scoreExperience(facts, roleBand);

  // ---- Components -----------------------------------------------------------
  //
  // These four read facts. They share whatever weight is left once the wording
  // component below has taken its fixed, capped share.
  const evidenceComponents: FitScoreComponent[] = [
    component('must_haves', 'Must-haves met', 0.33, mustHaveScore,
      mustHaveCount === 0
        ? 'This role names no must-have competency or deep technology, so nothing is held against the CV here.'
        : `${mustHaveCount - mustHaveGapCount} of ${mustHaveCount} must-have${mustHaveCount === 1 ? '' : 's'} are evidenced on the CV${mustHaveGapCount ? `; missing: ${[...mustHaveCompetencyGaps.map((g) => g.name), ...mustHaveTechGaps.map((g) => g.item.name)].join(', ')}.` : '.'}`,
      'A must-have the CV does not evidence is named, not silently averaged away.',
      [...mustHaveCompetencyGaps, ...reads.filter((r) => r.mustHave && r.strength !== 'not_evidenced')].flatMap((r) => r.evidence).slice(0, 4)),

    component('competencies', 'Scorecard competencies', 0.30, competencyScore,
      competencies.length === 0
        ? 'This role has no scored competencies yet, so there is nothing to read the CV against.'
        : `${reads.filter((r) => r.strength === 'evidenced').length} of ${competencies.length} competencies are evidenced by work the CV describes, ${reads.filter((r) => r.strength === 'partial').length} are claimed but thin, and ${reads.filter((r) => r.strength === 'not_evidenced').length} are not mentioned.`,
      "Each competency is weighted as the role's approved scorecard weights it; an unmentioned one is carried at a neutral, not at zero.",
      reads.filter((r) => r.strength === 'evidenced').flatMap((r) => r.evidence.slice(0, 2)), PLANNER_EVIDENCE_LIMIT),

    ...(techStack.length
      ? [component('tech_stack', 'Role technologies', 0.23, stackScore,
          `${readings.filter((r) => r.strength !== 'not_evidenced').length} of ${techStack.length} of this role's technologies appear in the CV; required ones and the depth the role asks for count for more, and a technology last used more than ${STALE_YEARS} years ago counts for less than a current one.`,
          'Required technologies weigh more than nice-to-haves, and recent use weighs more than old use.',
          readings.filter((r) => r.strength !== 'not_evidenced').flatMap((r) => r.evidence).slice(0, 4))]
      : []),

    component('experience', `Scope at ${roleBand.label}`, 0.10, experience.score, experience.explanation,
      'Scope the candidate evidences having owned, read against the level this role is pitched at. Years are never read on their own.',
      experience.evidence),
  ];

  /**
   * The one wording-sensitive part, at a FIXED weight.
   *
   * It is added after the others are renormalised rather than renormalised with
   * them, because a role with no technology list has one fewer evidence
   * component — and sharing the slack would quietly raise this one's weight on
   * exactly those roles. The cap has to be the same everywhere or it is not a
   * cap.
   */
  const wording = component('outcomes', 'What the role is for', PRESENTATION_MAX_POINTS / 100, outcome.score, outcome.explanation,
    `Overlap between the role's stated outcomes and work the CV describes doing. This is the only part of the score that depends on how the CV is worded, so it is held to ${PRESENTATION_MAX_POINTS} points out of a hundred.`,
    outcome.evidence);

  const evidenceShare = 1 - wording.weight;
  const weightSum = evidenceComponents.reduce((a, c) => a + c.weight, 0);
  const scaled = evidenceComponents.map((c) => ({ ...c, weight: round2((c.weight / weightSum) * evidenceShare) }));
  // Rounding each share to two places loses up to a point of weight, which both
  // depresses the score and makes the weights on screen fail to add to 100.
  // The remainder goes to the largest part, so the column always totals 100 and
  // the arithmetic a reader does by hand comes out to the number shown.
  const residual = round2(evidenceShare - scaled.reduce((a, c) => a + c.weight, 0));
  if (residual !== 0 && scaled.length > 0) {
    const largest = scaled.reduce((a, c) => (c.weight > a.weight ? c : a), scaled[0]);
    largest.weight = round2(largest.weight + residual);
  }
  const components = [...scaled, wording];

  const overall = clamp(Math.round(components.reduce((a, c) => a + c.score * c.weight, 0)), 0, 100);

  const band = fitBandOf(overall, coverage, mustHaveGapCount);
  const notEvidenced = reads.filter((r) => r.strength === 'not_evidenced').map((r) => r.name);
  const probeDetail = buildProbes({ reads, readings, roleBand: roleBand.id });

  const fit: FitScore = {
    overall,
    confidence: confidenceOf(coverage, facts),
    components,
    // Exact competency names, because the interview planner reads this list by
    // name to decide where to pitch a question ladder (library/planLadders.ts).
    missing: [...notEvidenced, ...readings.filter((r) => r.item.required && r.strength === 'not_evidenced').map((r) => `${r.item.name} (required technology)`)].slice(0, 12),
    probes: probeDetail.map((p) => p.text).slice(0, 10),
    excludedSignals: [...EXCLUDED_SIGNALS],
    band,
    meaning: FIT_BAND_MEANINGS[band],
    coverage,
    competencies: reads,
    technologies,
    mustHaveGaps: [...mustHaveCompetencyGaps.map((g) => g.name), ...mustHaveTechGaps.map((g) => `${g.item.name} (required technology)`)],
    niceToHavesPresent: [
      ...reads.filter((r) => r.classification === 'preferred' && r.strength !== 'not_evidenced').map((r) => r.name),
      ...readings.filter((r) => !r.item.required && r.strength !== 'not_evidenced').map((r) => r.item.name),
    ],
    notEvidenced,
    probeDetail,
    experience: { roleBand: roleBand.id, explanation: experience.explanation },
    redaction: facts.redaction,
    engineVersion: FIT_ENGINE_VERSION,
    scorecardVersion: opts.scorecardVersion ?? null,
    techStackFingerprint: fingerprint(techStack),
    scoredAt: now.toISOString(),
  };

  return {
    fit,
    perCompetency: reads.map((r) => ({
      competencyId: r.competencyId,
      name: r.name,
      evidence: r.evidence.map((e) => e.quote),
      strength: LEGACY_STRENGTH[r.strength],
    })),
  };
}

// --- Component helpers --------------------------------------------------------

/**
 * `limit` exists for the competencies component alone. Its evidence is not only
 * shown — the interview planner reads it back to decide how hard to pitch each
 * question ladder (library/planLadders.ts `cvSignalsFor`, which counts how many
 * evidence spans name a competency). Four spans across a whole scorecard is not
 * enough for that count to mean anything, so this one component carries more.
 */
function component(key: string, label: string, weight: number, score: number, explanation: string, rule: string, evidence: readonly CvEvidence[], limit = 4): FitScoreComponent {
  const kept = evidence.slice(0, limit);
  return {
    key, label, weight, score: clamp(Math.round(score), 0, 100), rule, explanation,
    evidence: kept.map((e) => e.quote),
    evidenceDetail: kept.map((e) => ({ ...e })),
  };
}

/** Up to two lines per evidenced competency, so every one of them is represented. */
const PLANNER_EVIDENCE_LIMIT = 16;

const LEVEL_FACTOR: Readonly<Record<TechStackItem['level'], number>> = { familiar: 0.5, working: 1, strong: 1.5, expert: 2 };

/**
 * The stack, weighted the way the role asks for it: a required expert-level
 * technology counts four times what an optional familiarity does, and a
 * technology the CV last touched years ago counts less than one in current use.
 */
function scoreStack(readings: ReturnType<typeof readTechnologies>, abstraction: string): number {
  if (readings.length === 0) return 55;
  let weight = 0;
  let earned = 0;
  for (const r of readings) {
    const w = (r.item.required ? 1 : 0.35) * LEVEL_FACTOR[r.item.level];
    weight += w;
    earned += w * itemScore(r, abstraction);
  }
  return weight === 0 ? 55 : Math.round(earned / weight);
}

function itemScore(r: ReturnType<typeof readTechnologies>[number], abstraction: string): number {
  if (r.strength === 'not_evidenced') return r.item.required ? 20 : 45;
  if (r.recencyYears === null) return r.strength === 'partial' ? 55 : 68;
  if (r.recencyYears <= RECENT_YEARS) {
    // At system and organisation level a deep requirement wants depth behind it.
    const shallow = abstraction !== 'craft' && (r.item.level === 'strong' || r.item.level === 'expert') && (r.monthsUsed ?? 0) > 0 && (r.monthsUsed ?? 0) < 12;
    return shallow ? 65 : 95;
  }
  if (r.recencyYears <= STALE_YEARS) return 75;
  return 55;
}

const OUTCOME_STOPWORDS = /\b(the|and|for|with|from|that|this|into|their|will|must|should|able|across|within|ensure|ensuring|deliver|delivering|support|supporting|work|working)\b/gi;

/**
 * Does the CV describe doing the kind of work this role exists to do?
 *
 * Only the ROLE's own vocabulary counts, so a longer CV gains nothing by being
 * longer: extra words that are not the role's words score nothing.
 */
function scoreOutcomes(role: RoleSuccessProfile, facts: CvFacts): { score: number; explanation: string; evidence: CvEvidence[] } {
  const vocabulary = new Set(
    [...(role.outcomes ?? []), ...(role.responsibilities ?? [])]
      .join(' ')
      .replace(OUTCOME_STOPWORDS, ' ')
      .toLowerCase()
      .match(/[a-z][a-z-]{4,}/g) ?? [],
  );
  if (vocabulary.size === 0) {
    return { score: 55, explanation: 'This role does not state what it is for yet, so there is nothing to read the CV against here.', evidence: [] };
  }
  const doing = facts.lines.filter((l) => !l.injection && (l.section === 'experience' || l.section === 'projects' || l.section === 'summary'));
  const matched = new Set<string>();
  const evidence: CvEvidence[] = [];
  for (const line of doing) {
    const lower = line.text.toLowerCase();
    const hit = [...vocabulary].filter((w) => lower.includes(w));
    if (hit.length === 0) continue;
    for (const w of hit) matched.add(w);
    if (evidence.length < 4) evidence.push({ line: line.index, quote: line.text, section: line.section });
  }
  const share = matched.size / vocabulary.size;
  return {
    score: Math.round(40 + Math.min(1, share * 2.5) * 55),
    explanation: matched.size === 0
      ? 'The CV describes no work in the terms this role states its outcomes in, which is a thing to ask about rather than a thing to conclude from.'
      : `The CV describes work in ${matched.size} of the ${vocabulary.size} terms this role states its outcomes and responsibilities in.`,
    evidence,
  };
}

const BAND_SCOPE_NEEDS: Readonly<Record<string, readonly string[]>> = {
  craft: [],
  system: ['scale', 'team'],
  organisation: ['team', 'budget', 'revenue'],
};

function scoreExperience(facts: CvFacts, band: ReturnType<typeof bandForRoleSeniority>): { score: number; explanation: string; evidence: CvEvidence[] } {
  const needs = BAND_SCOPE_NEEDS[band.abstraction] ?? [];
  const present = new Set(facts.scope.map((s) => s.kind));
  const met = needs.filter((k) => present.has(k as never));
  const evidence = facts.scope.filter((s) => needs.length === 0 || needs.includes(s.kind)).slice(0, 4).map((s) => s.evidence);
  const base = needs.length === 0 ? (facts.scope.length > 0 ? 80 : 68) : 40 + Math.round((met.length / needs.length) * 55);
  return {
    score: base,
    explanation: experienceSentence(band, met, needs, facts),
    evidence,
  };
}

/**
 * How much of the scorecard the CV actually speaks to, plus a penalty when the
 * CV barely parsed. Confidence is where readability belongs — a badly formatted
 * CV should make us less sure, never make the candidate look worse.
 */
function confidenceOf(coverage: number, facts: CvFacts): number {
  let c = 0.3 + coverage * 0.6;
  if (facts.roles.length === 0) c -= 0.15;
  if (facts.lines.length < 12) c -= 0.1;
  if (facts.redaction.injectionLines.length > 0) c -= 0.05;
  return round2(clamp(c, 0.2, 0.95));
}

function fingerprint(stack: readonly TechStackItem[]): string {
  return techStackNames(stack).map((n) => n.toLowerCase()).sort().join('|');
}

function textFromProfile(profile: NormalizedProfile | Record<string, never>): string {
  const p = profile as Partial<NormalizedProfile>;
  const parts: string[] = [];
  if (p.skills?.length) parts.push('Skills', p.skills.join(', '));
  if (p.employment?.length) {
    parts.push('Experience');
    for (const job of p.employment) {
      parts.push([job.title, job.company, job.start, job.end].filter(Boolean).join(' - '));
      parts.push(...(job.bullets ?? []));
    }
  }
  if (p.projects?.length) {
    parts.push('Projects');
    for (const project of p.projects) parts.push(`${project.name} ${project.summary}`.trim());
  }
  if (p.certifications?.length) parts.push('Certifications', ...p.certifications);
  if (p.education?.length) parts.push('Education', ...p.education.map((e) => e.degree));
  return parts.filter(Boolean).join('\n');
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

export { emptyFacts };
export type { FitProbe };
