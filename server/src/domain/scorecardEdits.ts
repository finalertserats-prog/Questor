import { nanoid } from 'nanoid';
import type { Competency, RoleSuccessProfile } from './types.js';
import { COMPETENCY_MAX_COUNT, isScored } from './profileSchema.js';

/**
 * Editing the competencies of a role's success profile, one change at a time.
 *
 * Every function here returns a new profile and leaves the one it was given
 * untouched. The invariant they all keep is the one the engines assume: the
 * weights of the scored competencies are shares of one score and sum to 1.
 * The rule for keeping it is proportional — the competency being changed gets
 * the weight asked for (or an equal share, for a new one), and everything else
 * scales to fill the rest — so an edit to one row never rewrites the ranking HR
 * chose between the others.
 */

export class ScorecardEditError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'ScorecardEditError';
  }
}

export interface CompetencyInput {
  readonly name: string;
  readonly definition: string;
  readonly category: Competency['category'];
  readonly classification: Competency['classification'];
  readonly indicators: readonly string[];
  readonly requiredLevel?: Competency['requiredLevel'];
  readonly targetLevel?: Competency['targetLevel'];
  readonly evidenceModes?: readonly string[];
  /** A share of the score, 0..1. Absent means an equal share. */
  readonly weight?: number;
  readonly mustPass?: boolean;
}

export type CompetencyPatch = Partial<Omit<CompetencyInput, 'evidenceModes'>>;

/** The competencies that still take part in interviews: everything not retired. */
export function activeCompetencies<T extends { readonly retired?: boolean }>(profile: { readonly competencies: readonly T[] }): T[] {
  return profile.competencies.filter((c) => c.retired !== true);
}

/**
 * HR-entered text as it may be stored and put in front of a model. One line,
 * single-spaced, with control characters removed: a definition that contained
 * a line break could otherwise open a new "field" inside an interviewer prompt
 * that lists the role's facts one per line.
 */
export function cleanCompetencyText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

const RESERVED_ID_PREFIX = '__';

function assertUsableId(profile: RoleSuccessProfile, id: string): void {
  if (id.startsWith(RESERVED_ID_PREFIX)) {
    throw new ScorecardEditError(`Competency ids starting with "${RESERVED_ID_PREFIX}" are reserved for the interview plan.`, 'reserved_id');
  }
  if (profile.competencies.some((c) => c.id === id)) {
    throw new ScorecardEditError(`Competency id "${id}" is already on the scorecard.`, 'duplicate_id');
  }
}

function assertUnusedName(profile: RoleSuccessProfile, name: string, exceptId?: string): void {
  const key = name.toLowerCase();
  if (profile.competencies.some((c) => c.id !== exceptId && c.retired !== true && c.name.toLowerCase() === key)) {
    throw new ScorecardEditError(`"${name}" is already a competency on this scorecard.`, 'duplicate_name');
  }
}

function find(profile: RoleSuccessProfile, id: string): Competency {
  const found = profile.competencies.find((c) => c.id === id);
  if (!found) throw new ScorecardEditError('That competency is not on the scorecard.', 'unknown_competency');
  return found;
}

/** Whole thousandths, with the rounding remainder placed on the largest share. */
function roundShares(weights: readonly number[]): number[] {
  const rounded = weights.map((w) => Math.round(w * 1000) / 1000);
  const total = rounded.reduce((sum, w) => sum + w, 0);
  const remainder = Math.round((1 - total) * 1000) / 1000;
  if (remainder === 0 || rounded.length === 0) return rounded;
  const largest = rounded.indexOf(Math.max(...rounded));
  return rounded.map((w, i) => (i === largest ? Math.round((w + remainder) * 1000) / 1000 : w));
}

/**
 * Scale every scored weight so the scored total is 1. When `fixedId` is given
 * that competency keeps its weight and only the others scale to fill the rest.
 * Zero all round — a freshly written scorecard, or one whose only scored
 * competency was just removed — splits equally rather than dividing by zero.
 */
function rebalance(profile: RoleSuccessProfile, fixedId?: string): RoleSuccessProfile {
  const scored = profile.competencies.filter(isScored);
  const fixed = scored.find((c) => c.id === fixedId);
  const fixedWeight = fixed ? Math.min(1, Math.max(0, fixed.weight)) : 0;
  const others = scored.filter((c) => c.id !== fixedId);
  const othersTotal = others.reduce((sum, c) => sum + c.weight, 0);
  const room = 1 - fixedWeight;
  const shares = others.map((c) => (othersTotal > 0 ? (c.weight / othersTotal) * room : others.length ? room / others.length : 0));
  const rounded = roundShares(fixed ? [fixedWeight, ...shares] : shares);
  const byId = new Map<string, number>();
  if (fixed) byId.set(fixed.id, rounded[0]);
  others.forEach((c, i) => byId.set(c.id, rounded[fixed ? i + 1 : i]));
  return {
    ...profile,
    competencies: profile.competencies.map((c) => ({ ...c, weight: isScored(c) ? byId.get(c.id) ?? 0 : 0 })),
  };
}

/** The scored weights normalised to sum to 1, non-scoring and retired at 0. */
export function rebalanceWeights(profile: RoleSuccessProfile): RoleSuccessProfile {
  return rebalance(profile);
}

function withMustPass(profile: RoleSuccessProfile, id: string, mustPass: boolean | undefined): RoleSuccessProfile {
  if (mustPass === undefined) return profile;
  const current = profile.scoringRules.mustPassCompetencyIds;
  const next = mustPass ? (current.includes(id) ? current : [...current, id]) : current.filter((m) => m !== id);
  return { ...profile, scoringRules: { ...profile.scoringRules, mustPassCompetencyIds: next } };
}

/** A scored competency's opening weight: an equal share of the scored set it joins. */
function equalShare(profile: RoleSuccessProfile, joiningId: string): number {
  const count = profile.competencies.filter((c) => c.id !== joiningId && isScored(c)).length + 1;
  return 1 / count;
}

export function addCompetency(profile: RoleSuccessProfile, input: CompetencyInput, opts: { readonly id?: string } = {}): RoleSuccessProfile {
  if (profile.competencies.length >= COMPETENCY_MAX_COUNT) {
    throw new ScorecardEditError(`A scorecard holds at most ${COMPETENCY_MAX_COUNT} competencies.`, 'too_many');
  }
  const id = opts.id ?? nanoid(8);
  assertUsableId(profile, id);
  const name = cleanCompetencyText(input.name);
  assertUnusedName(profile, name);
  const scored = input.classification !== 'non_scoring';
  const competency: Competency = {
    id,
    name,
    definition: cleanCompetencyText(input.definition),
    category: input.category,
    classification: input.classification,
    weight: scored ? input.weight ?? equalShare(profile, id) : 0,
    requiredLevel: input.requiredLevel ?? 2,
    targetLevel: input.targetLevel ?? 4,
    indicators: input.indicators.map(cleanCompetencyText).filter(Boolean),
    evidenceModes: [...(input.evidenceModes ?? ['behavioral_example', 'technical_explanation'])],
  };
  const added = { ...profile, competencies: [...profile.competencies, competency] };
  // Must-pass is a promise to assess; a non-scoring competency cannot carry it.
  return withMustPass(scored ? rebalance(added, id) : added, id, scored ? input.mustPass : false);
}

export function updateCompetency(profile: RoleSuccessProfile, id: string, patch: CompetencyPatch): RoleSuccessProfile {
  const current = find(profile, id);
  if (current.retired && (patch.weight !== undefined || patch.classification !== undefined || patch.mustPass)) {
    throw new ScorecardEditError('A retired competency is no longer scored; add it again to assess it.', 'retired');
  }
  const name = patch.name !== undefined ? cleanCompetencyText(patch.name) : current.name;
  if (patch.name !== undefined) assertUnusedName(profile, name, id);
  const classification = patch.classification ?? current.classification;
  const becomesScored = classification !== 'non_scoring' && current.classification === 'non_scoring';
  const scoredNow = classification !== 'non_scoring' && !current.retired;
  if (!scoredNow && isScored(current)) assertScoredRemains(profile, id);
  const weight = !scoredNow ? 0 : patch.weight !== undefined ? patch.weight : becomesScored ? equalShare(profile, id) : current.weight;
  const next: Competency = {
    ...current,
    name,
    definition: patch.definition !== undefined ? cleanCompetencyText(patch.definition) : current.definition,
    category: patch.category ?? current.category,
    classification,
    weight,
    requiredLevel: patch.requiredLevel ?? current.requiredLevel,
    targetLevel: patch.targetLevel ?? current.targetLevel,
    indicators: patch.indicators !== undefined ? patch.indicators.map(cleanCompetencyText).filter(Boolean) : current.indicators,
  };
  const replaced = { ...profile, competencies: profile.competencies.map((c) => (c.id === id ? next : c)) };
  const weightsMoved = patch.weight !== undefined || patch.classification !== undefined;
  const rebalanced = weightsMoved ? rebalance(replaced, scoredNow ? id : undefined) : replaced;
  // Must-pass is a promise to assess; a competency that is no longer scored cannot keep it.
  return withMustPass(rebalanced, id, scoredNow ? patch.mustPass : false);
}

/**
 * A scorecard with nothing scored plans no competency blocks and grades
 * nothing, so the last scored competency cannot be removed, retired or made
 * non-scoring until another one is scored.
 */
function assertScoredRemains(profile: RoleSuccessProfile, changingId: string): void {
  if (!profile.competencies.some((c) => c.id !== changingId && isScored(c))) {
    throw new ScorecardEditError('At least one competency must stay scored. Make another competency scored first.', 'last_scored');
  }
}

function dropFromMustPass(profile: RoleSuccessProfile, id: string): RoleSuccessProfile {
  return withMustPass(profile, id, false);
}

export function removeCompetency(profile: RoleSuccessProfile, id: string): RoleSuccessProfile {
  find(profile, id);
  if (activeCompetencies(profile).filter((c) => c.id !== id).length === 0) {
    throw new ScorecardEditError('The last competency cannot be removed; a scorecard needs at least one.', 'last_competency');
  }
  if (isScored(find(profile, id))) assertScoredRemains(profile, id);
  const without = { ...profile, competencies: profile.competencies.filter((c) => c.id !== id) };
  return dropFromMustPass(rebalance(without), id);
}

/**
 * Stop assessing a competency without losing it. Used instead of removal when
 * an interview has already asked about it: the old plan, transcript turns and
 * assessment all carry its id, and a feedback letter written later must still
 * be able to name it.
 */
export function retireCompetency(profile: RoleSuccessProfile, id: string): RoleSuccessProfile {
  find(profile, id);
  if (activeCompetencies(profile).filter((c) => c.id !== id).length === 0) {
    throw new ScorecardEditError('The last competency cannot be retired; a scorecard needs at least one.', 'last_competency');
  }
  if (isScored(find(profile, id))) assertScoredRemains(profile, id);
  const retired = { ...profile, competencies: profile.competencies.map((c) => (c.id === id ? { ...c, retired: true, weight: 0 } : c)) };
  return dropFromMustPass(rebalance(retired), id);
}

// ---- What the downstream limits will do with this scorecard -----------------

/**
 * Mirrors of two fixed limits elsewhere, so the editor can say what will
 * happen before an interview or a letter makes it happen. The limits stay
 * where they are (engines/interviewPlanner.ts, services/feedbackContentModel.ts);
 * these numbers describe them, they do not set them.
 */
const PLANNER_MIN_COMPETENCY_MINUTES = 2;
const FEEDBACK_LETTER_MAX_COMPETENCIES = 8;
const DEFAULT_INTERVIEW_MINUTES = 45;

/** How many competency blocks the planner can fit in an interview of this length. */
function plannerCapacity(durationMinutes: number): number {
  const tenth = Math.floor(durationMinutes * 0.15);
  let remaining = Math.max(0, durationMinutes - Math.min(3, Math.max(1, tenth)) * 2);
  remaining -= remaining >= 6 ? 4 : remaining >= 4 ? 2 : 0;
  remaining -= remaining >= PLANNER_MIN_COMPETENCY_MINUTES + 3 ? 3 : 0;
  return Math.max(1, Math.floor(remaining / PLANNER_MIN_COMPETENCY_MINUTES));
}

export function scorecardWarnings(profile: RoleSuccessProfile, durationMinutes = DEFAULT_INTERVIEW_MINUTES): string[] {
  const scored = profile.competencies.filter(isScored);
  const warnings: string[] = [];
  const capacity = plannerCapacity(durationMinutes);
  const dropped = [...scored].sort((a, b) => b.weight - a.weight).slice(capacity);
  for (const c of dropped) {
    warnings.push(`At ${Math.round(c.weight * 100)}% weight in a ${durationMinutes}-minute interview, ${c.name} will not be assessed: the plan has time for ${capacity} competencies.`);
  }
  if (scored.length > FEEDBACK_LETTER_MAX_COMPETENCIES) {
    warnings.push(`The candidate's feedback letter shows at most ${FEEDBACK_LETTER_MAX_COMPETENCIES} competencies; ${scored.length} are scored, so the least covered will be left out of it.`);
  }
  return warnings;
}
