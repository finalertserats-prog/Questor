/**
 * Which fields may be drafted, and what is said where one may not — the
 * browser's copy of server/src/domain/fieldDrafts.ts.
 *
 * It is a copy because the browser cannot import from the server workspace.
 * A copy that drifts is how two vocabularies grow, so
 * server/tests/fieldDraftVocabulary.test.ts reads this file as text and fails
 * if a flag or a refusal sentence parts company with the server's.
 *
 * The boundary itself is enforced on the server (the suggest route answers 422
 * for a judgement field whatever the browser believes). This copy exists so
 * the page can say WHY no draft is offered, in the same words, without a
 * round trip — and so a component cannot accidentally offer one.
 */

export const DRAFT_FIELD_KEYS = [
  'role_summary',
  'job_description',
  'competency_definition',
  'competency_indicators',
  'candidate_message',
  'scheduling_note',
  'round_note',
  'verdict_reason',
  'level_override_reason',
  'evidence_note',
] as const;

export type DraftFieldKey = (typeof DRAFT_FIELD_KEYS)[number];

export interface FieldDraftRule {
  readonly suggest: boolean;
  readonly tidy: boolean;
  /** Shown under the field where no draft is offered. Empty where one is. */
  readonly refusal: string;
}

const JUDGEMENT_REFUSAL =
  'No draft is offered here. This is the record of your own judgement, and a pre-written one would make '
  + 'the human oversight a rubber stamp.';

const OBSERVATION_REFUSAL =
  'No draft is offered here. These are your own observations of a person; nothing may be invented into them. '
  + 'You can tidy up what you have written.';

const RULES: Readonly<Record<DraftFieldKey, FieldDraftRule>> = {
  role_summary: { suggest: true, tidy: true, refusal: '' },
  job_description: { suggest: true, tidy: true, refusal: '' },
  competency_definition: { suggest: true, tidy: true, refusal: '' },
  competency_indicators: { suggest: true, tidy: true, refusal: '' },
  candidate_message: { suggest: true, tidy: true, refusal: '' },
  scheduling_note: { suggest: true, tidy: true, refusal: '' },
  round_note: { suggest: false, tidy: true, refusal: OBSERVATION_REFUSAL },
  verdict_reason: { suggest: false, tidy: true, refusal: JUDGEMENT_REFUSAL },
  level_override_reason: { suggest: false, tidy: true, refusal: JUDGEMENT_REFUSAL },
  evidence_note: { suggest: false, tidy: true, refusal: JUDGEMENT_REFUSAL },
};

export function fieldDraftRule(key: DraftFieldKey): FieldDraftRule {
  return RULES[key];
}

export function mayOfferDraft(key: DraftFieldKey): boolean {
  return RULES[key].suggest;
}

export function mayTidy(key: DraftFieldKey): boolean {
  return RULES[key].tidy;
}
