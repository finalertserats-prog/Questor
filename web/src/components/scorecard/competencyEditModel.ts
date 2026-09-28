/**
 * The rules behind editing competencies on the role page, kept free of React
 * so they can be unit tested (web/tests/competencyEditModel.test.ts).
 *
 * The server holds the same arithmetic (server/src/domain/scorecardEdits.ts)
 * and is the one that counts. This copy exists so the weight total on screen
 * moves as the person types rather than after a refused save.
 */

import type { CompetencyProvenance } from './competencySourceModel';

export type Category = 'technical' | 'domain' | 'behavioral' | 'situational' | 'communication';
export type Classification = 'essential' | 'preferred' | 'trainable' | 'non_scoring';

export const CATEGORIES: readonly Category[] = ['technical', 'domain', 'behavioral', 'situational', 'communication'];
export const CLASSIFICATIONS: readonly Classification[] = ['essential', 'preferred', 'trainable', 'non_scoring'];

export const COMPETENCY_NAME_MAX_LENGTH = 120;
export const COMPETENCY_DEFINITION_MAX_LENGTH = 1000;
export const INDICATOR_MAX_COUNT = 20;
export const INDICATOR_MAX_LENGTH = 300;

/**
 * A competency as the role page edits it, carrying the provenance the server
 * sends with it. The provenance is never edited here — it records where the
 * competency came from, which no amount of later editing changes — but it
 * travels with the row so it can be shown beside it.
 */
export interface EditableCompetency extends CompetencyProvenance {
  readonly id: string;
  readonly name: string;
  readonly definition: string;
  readonly category: Category;
  readonly classification: Classification;
  readonly weight: number;
  readonly requiredLevel: number;
  readonly targetLevel: number;
  readonly indicators: readonly string[];
  readonly retired?: boolean;
}

/** Whether a competency still takes part in the score. */
export function isScored(c: { readonly classification: string; readonly retired?: boolean }): boolean {
  return c.classification !== 'non_scoring' && c.retired !== true;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * The scored weights scaled so they sum to 1, with `fixedId` keeping the
 * weight it has and only the others moving. Non-scoring and retired stay at 0.
 */
export function rebalanceWeights<T extends EditableCompetency>(competencies: readonly T[], fixedId?: string): T[] {
  const scored = competencies.filter(isScored);
  const fixed = scored.find((c) => c.id === fixedId);
  const fixedWeight = fixed ? Math.min(1, Math.max(0, fixed.weight)) : 0;
  const others = scored.filter((c) => c.id !== fixedId);
  const othersTotal = others.reduce((sum, c) => sum + c.weight, 0);
  const room = 1 - fixedWeight;
  const share = (c: T) => (othersTotal > 0 ? (c.weight / othersTotal) * room : others.length ? room / others.length : 0);
  return competencies.map((c) => {
    if (!isScored(c)) return { ...c, weight: 0 };
    return { ...c, weight: round3(c.id === fixedId ? fixedWeight : share(c)) };
  });
}

/** One competency changed; the weights of the rest follow. */
export function applyCompetencyPatch<T extends EditableCompetency>(competencies: readonly T[], id: string, patch: Partial<EditableCompetency>): T[] {
  const current = competencies.find((c) => c.id === id);
  if (!current) return [...competencies];
  const classification = patch.classification ?? current.classification;
  const becomesScored = classification !== 'non_scoring' && current.classification === 'non_scoring';
  const scoredCount = competencies.filter((c) => c.id !== id && isScored(c)).length + 1;
  const weight = classification === 'non_scoring' ? 0 : patch.weight !== undefined ? patch.weight : becomesScored ? 1 / scoredCount : current.weight;
  const replaced = competencies.map((c) => (c.id === id ? { ...c, ...patch, classification, weight } : c));
  const weightsMoved = patch.weight !== undefined || patch.classification !== undefined;
  return weightsMoved ? rebalanceWeights(replaced, classification === 'non_scoring' ? undefined : id) : replaced;
}

/** The must-pass list with a competency added or dropped. */
export function toggleMustPass(ids: readonly string[], id: string, on: boolean): string[] {
  if (on) return ids.includes(id) ? [...ids] : [...ids, id];
  return ids.filter((m) => m !== id);
}

/**
 * The must-pass list after a row edit: a competency made non-scoring (or
 * retired) leaves it in the same change, because a must-pass that is never
 * assessed is a promise the server refuses to store.
 */
export function mustPassAfterPatch(ids: readonly string[], id: string, patch: Partial<EditableCompetency>): string[] {
  const leavesScoring = patch.classification === 'non_scoring' || patch.retired === true;
  return leavesScoring ? toggleMustPass(ids, id, false) : [...ids];
}

/** One indicator per line, trimmed, blanks dropped, capped at the server's limits. */
export function indicatorsFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().slice(0, INDICATOR_MAX_LENGTH))
    .filter(Boolean)
    .slice(0, INDICATOR_MAX_COUNT);
}

export function indicatorsToText(indicators: readonly string[]): string {
  return indicators.join('\n');
}

/** Why a name cannot be used, as a sentence for the field, or null. */
export function competencyNameProblem(competencies: readonly { readonly id: string; readonly name: string; readonly retired?: boolean }[], name: string, exceptId?: string): string | null {
  const clean = name.trim().split(/\s+/).join(' ');
  if (!clean) return 'Give the competency a name first.';
  if (clean.length > COMPETENCY_NAME_MAX_LENGTH) return `Keep the name under ${COMPETENCY_NAME_MAX_LENGTH} characters.`;
  const lower = clean.toLowerCase();
  const clash = competencies.some((c) => c.retired !== true && c.id !== exceptId && c.name.toLowerCase() === lower);
  if (clash) return 'That competency is already on the scorecard.';
  return null;
}

/** What the Remove button will do, in words, given whether interviews used the competency. */
export function removalLabel(hasHistory: boolean): { label: string; explanation: string } {
  return hasHistory
    ? { label: 'Retire', explanation: 'Interviews have already assessed this competency, so it is retired rather than deleted: it stops being asked and scored, and stays on record for those assessments.' }
    : { label: 'Remove', explanation: 'No interview has used this competency yet, so it is deleted from the scorecard.' };
}

/**
 * Whether taking a competency off the scorecard needs a second click.
 *
 * A wrongly extracted competency is the thing this page most needs to make
 * easy to get rid of: it is a claim about the job that nobody agreed to, and
 * the reviewer is looking at it precisely to catch that. While no interview
 * has used it, removing is a plain deletion of an unused draft row, so it
 * happens on the one click.
 *
 * Once interviews have assessed it, the same button retires it, which changes
 * what an existing assessment means. That one still asks.
 */
export function removalNeedsConfirm(hasHistory: boolean): boolean {
  return hasHistory;
}

export interface CompetencyDraft {
  readonly definition: string;
  readonly indicators: readonly string[];
  readonly category: Category;
  readonly suggestedClassification: Classification;
}

/** The add form's fields once a draft comes back: the draft fills what is empty, never what was typed. */
export interface AddForm {
  readonly name: string;
  readonly definition: string;
  readonly category: Category;
  readonly classification: Classification;
  readonly indicatorsText: string;
  readonly mustPass: boolean;
}

export const EMPTY_ADD_FORM: AddForm = { name: '', definition: '', category: 'domain', classification: 'preferred', indicatorsText: '', mustPass: false };

export function applyDraft(form: AddForm, draft: CompetencyDraft): AddForm {
  return {
    ...form,
    definition: form.definition.trim() ? form.definition : draft.definition,
    indicatorsText: form.indicatorsText.trim() ? form.indicatorsText : indicatorsToText(draft.indicators),
    category: draft.category,
    classification: draft.suggestedClassification,
  };
}

/** What the page sends to POST /roles/:id/scorecard/competencies. */
export function addPayload(form: AddForm): { name: string; definition: string; category: Category; classification: Classification; indicators: string[]; mustPass: boolean } {
  return {
    name: form.name.trim().split(/\s+/).join(' '),
    definition: form.definition.trim().slice(0, COMPETENCY_DEFINITION_MAX_LENGTH),
    category: form.category,
    classification: form.classification,
    indicators: indicatorsFromText(form.indicatorsText),
    // A non-scoring competency is never assessed, so it cannot be must-pass.
    mustPass: form.classification === 'non_scoring' ? false : form.mustPass,
  };
}
