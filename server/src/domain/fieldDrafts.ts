import type { Capability } from './capabilities.js';

/**
 * Which text fields the product may draft for a person, and which it may not.
 *
 * THE BOUNDARY, AND WHY IT IS DRAWN HERE
 *
 * Questor's claim is that a machine assesses and a PERSON judges. The EU AI
 * Act's human-oversight expectation says the same thing in law: the person in
 * the loop has to be able to form and record their own view, not confirm one
 * that was put in front of them. A field that holds the record of that
 * judgement — the reviewer's verdict reason, their evidence notes, the reason
 * they moved a competency level — must therefore never be pre-filled. Offer a
 * draft there and oversight becomes a rubber stamp: the reviewer edits the
 * machine's sentence instead of writing their own, and blind review, which
 * exists precisely to stop the AI anchoring the human, is undone by the text
 * box underneath it.
 *
 * An adversarial review of the plan flagged drafting judgement fields as its
 * biggest flaw. `suggest: false` on those fields is the answer to it, and it
 * lives in the domain — not in a component — so a new caller cannot reach a
 * forbidden field by forgetting a check in the browser.
 *
 * What IS allowed is authoring and communication: the words of a job, a
 * message to a candidate, logistics. Those are writing tasks, not judgements.
 *
 * `tidy` is a separate permission on purpose. Tidying rewrites what the person
 * ALREADY wrote — it cannot originate a judgement, because there is nothing to
 * rewrite until they have made one — so it is allowed on fields a fresh draft
 * is not. Round notes are the clearest case: they record what a human observer
 * saw, so nothing may be invented into them, but a hurried note may be tidied.
 */

export interface FieldDraftSpec {
  readonly key: DraftFieldKey;
  /** Said to the person, and in the audit record. */
  readonly label: string;
  /** May the product offer text for an empty field? False for every judgement field. */
  readonly suggest: boolean;
  /** May the product rewrite what the person already wrote? */
  readonly tidy: boolean;
  /** Hard ceiling on what the model may produce for this field. */
  readonly maxChars: number;
  /** The capability a caller must hold to ask for this field's draft. */
  readonly capability: Capability;
  /** Told to the model: what this field is for. */
  readonly guidance: string;
  /**
   * Why no draft is offered, said to the person in one line. Empty where a
   * draft IS offered. Written here so every surface says the same thing.
   */
  readonly refusal: string;
}

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

const JUDGEMENT_REFUSAL =
  'No draft is offered here. This is the record of your own judgement, and a pre-written one would make '
  + 'the human oversight a rubber stamp.';

const OBSERVATION_REFUSAL =
  'No draft is offered here. These are your own observations of a person; nothing may be invented into them. '
  + 'You can tidy up what you have written.';

const SPECS: Readonly<Record<DraftFieldKey, FieldDraftSpec>> = {
  role_summary: {
    key: 'role_summary', label: 'Role summary', suggest: true, tidy: true, maxChars: 1200,
    capability: 'role:create', refusal: '',
    guidance: 'A short summary of a job: what the person will own, who they work with, what success looks like.',
  },
  job_description: {
    key: 'job_description', label: 'Job description', suggest: true, tidy: true, maxChars: 6000,
    capability: 'role:create', refusal: '',
    guidance: 'The advert a candidate reads: the role, the work, what the team is looking for.',
  },
  competency_definition: {
    key: 'competency_definition', label: 'Competency definition', suggest: true, tidy: true, maxChars: 800,
    capability: 'role:create', refusal: '',
    guidance: 'What one competency means IN THIS ROLE — the capability, not a candidate. Never name or describe a person.',
  },
  competency_indicators: {
    key: 'competency_indicators', label: 'Competency indicators', suggest: true, tidy: true, maxChars: 1200,
    capability: 'role:create', refusal: '',
    guidance: 'What an interviewer listens for, one indicator per line. Behaviour in the job, never a judgement of a candidate.',
  },
  candidate_message: {
    key: 'candidate_message', label: 'Message to the candidate', suggest: true, tidy: true, maxChars: 2500,
    capability: 'assessment:review', refusal: '',
    guidance: 'A courteous message to a candidate about process or logistics. State no outcome and no assessment of them.',
  },
  scheduling_note: {
    key: 'scheduling_note', label: 'Scheduling note', suggest: true, tidy: true, maxChars: 1200,
    capability: 'candidate:read', refusal: '',
    guidance: 'Practical arrangements: times, formats, who is joining, what to prepare.',
  },
  // Allowed to be tidied, never drafted: a round note is a human's record of
  // what they saw a candidate do.
  round_note: {
    key: 'round_note', label: 'Round notes', suggest: false, tidy: true, maxChars: 2500,
    capability: 'candidate:read', refusal: OBSERVATION_REFUSAL,
    guidance: 'Tidy the writer\'s own notes of a round. Add nothing, remove no observation, reach no conclusion.',
  },
  verdict_reason: {
    key: 'verdict_reason', label: 'Why — in your own words', suggest: false, tidy: true, maxChars: 4000,
    capability: 'assessment:review', refusal: JUDGEMENT_REFUSAL,
    guidance: 'Tidy the reviewer\'s own words. Add no judgement, no recommendation, and no fact that was not there.',
  },
  level_override_reason: {
    key: 'level_override_reason', label: 'Why you changed this level', suggest: false, tidy: true, maxChars: 2000,
    capability: 'assessment:review', refusal: JUDGEMENT_REFUSAL,
    guidance: 'Tidy the reviewer\'s own words. Add no judgement and no fact that was not there.',
  },
  evidence_note: {
    key: 'evidence_note', label: 'Evidence note', suggest: false, tidy: true, maxChars: 4000,
    capability: 'assessment:review', refusal: JUDGEMENT_REFUSAL,
    guidance: 'Tidy the reviewer\'s own words. Add no judgement and no fact that was not there.',
  },
};

export function isDraftFieldKey(value: unknown): value is DraftFieldKey {
  return typeof value === 'string' && (DRAFT_FIELD_KEYS as readonly string[]).includes(value);
}

export function fieldDraftSpec(key: DraftFieldKey): FieldDraftSpec {
  return SPECS[key];
}

/** Every field a fresh draft may be offered for. The complement is the judgement record. */
export function suggestibleFields(): readonly DraftFieldKey[] {
  return DRAFT_FIELD_KEYS.filter((key) => SPECS[key].suggest);
}

/**
 * The model's output, made safe to show: trimmed, fences and quotes stripped,
 * and cut to the field's ceiling at a sentence or word boundary so a capped
 * draft never ends mid-word.
 *
 * Returns '' for anything that is not worth showing. "Nothing" is a better
 * answer than a bad draft, everywhere in this feature.
 */
export function shapeDraft(raw: unknown, spec: FieldDraftSpec): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
    .replace(/^["“]([\s\S]*)["”]$/, '$1')
    .trim();
  // Too short to be a draft of anything. A one-word answer is the shape a
  // refusal ("Sorry", "None") arrives in, and showing it would be worse than
  // showing nothing.
  if (text.length < 12) return '';
  if (text.length <= spec.maxChars) return text;
  const cut = text.slice(0, spec.maxChars);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  if (sentence > spec.maxChars * 0.6) return cut.slice(0, sentence + 1).trim();
  const word = cut.lastIndexOf(' ');
  return (word > 0 ? cut.slice(0, word) : cut).trim();
}
