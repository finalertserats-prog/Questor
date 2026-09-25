import { z } from 'zod';
import { generateJson } from '../providers/llm/index.js';
import { fieldDraftSpec, shapeDraft, type DraftFieldKey } from '../domain/fieldDrafts.js';
import { aiFieldDraftsEnabledForTenant } from './fieldDraftPolicy.js';

/**
 * The text behind an offered draft and behind "tidy up what I wrote".
 *
 * Two rules shape everything here.
 *
 * NOTHING RATHER THAN SOMETHING BAD. `generateJson` returns null on a timeout,
 * a disabled provider, a demo tenant, unparseable JSON or a failed check, and
 * every one of those paths ends the same way: an empty string, which the
 * browser renders as no suggestion at all. A person who sees nothing types
 * their own sentence, which is the outcome we want anyway; a person who sees a
 * plausible-but-wrong draft may keep it. The model also has to say it is
 * confident, and an unconfident draft is dropped for the same reason.
 *
 * THE BOUNDARY IS ENFORCED HERE TOO, not only in the route and the browser.
 * `suggestFieldDraft` refuses any field whose spec says `suggest: false` — the
 * reviewer's verdict reason, their evidence notes, a level-override reason —
 * so no future caller can reach a judgement field by forgetting a check
 * upstream. See domain/fieldDrafts.ts for why that boundary exists.
 */

/**
 * One call must not outlive a person's patience in a text box.
 *
 * Tighter than the `authoring` budget on purpose. That budget is sized for a
 * person watching a spinner having asked for a whole job description; this is
 * a suggestion nobody asked for, under a field they are already typing in, and
 * a draft that arrives after they have written their own sentence is worse
 * than no draft at all.
 */
const DRAFT_TIMEOUT_MS = 12_000;

/** What the caller may send as context. Bounded because it is model input. */
export const MAX_CONTEXT_CHARS = 4_000;

const SUGGEST_SYSTEM = [
  'You draft text for a hiring product. You are writing FOR a person who will read your draft, keep it,',
  'edit it or throw it away. Write what a careful professional would write: plain, specific, no marketing',
  'language, no bullet-point padding, British English.',
  'Never describe, rate or judge a named candidate. Never state an outcome or a recommendation.',
  'If the context is too thin to write something genuinely useful, say so by setting confident to false',
  'rather than writing something generic.',
  'Respond with JSON: {"text": string, "confident": boolean}.',
].join(' ');

const TIDY_SYSTEM = [
  'You tidy up text a person has already written, for a hiring product.',
  'Rewrite THEIR words: fix grammar, spelling, punctuation, expand their shorthand and make the sentences',
  'readable. British English.',
  'You must not add an opinion, a judgement, a recommendation, a conclusion or any fact that is not already',
  'in their text, and you must not remove any observation they made. If their text is already clear, or if',
  'tidying it would change what it says, set confident to false and return their text unchanged.',
  'Respond with JSON: {"text": string, "confident": boolean}.',
].join(' ');

const replySchema = z.object({
  text: z.string(),
  confident: z.boolean(),
}).strict();

type Reply = z.infer<typeof replySchema>;

/**
 * A rough token ceiling from the field's character ceiling. Four characters to
 * a token is the usual English approximation; the +80 covers the JSON wrapper
 * so a draft at the character limit is not truncated into invalid JSON.
 */
function tokenCeiling(maxChars: number): number {
  return Math.ceil(maxChars / 4) + 80;
}

function bounded(context: string): string {
  return context.slice(0, MAX_CONTEXT_CHARS);
}

export interface SuggestInput {
  readonly tenantId: string;
  readonly field: DraftFieldKey;
  /** What the field is about: the role title, the competency name, the stage. */
  readonly context: string;
}

/** A refused field is a programming error upstream, not a user error. */
export class DraftNotAllowedError extends Error {
  constructor(readonly field: DraftFieldKey) {
    super(`No draft may be offered for "${field}".`);
    this.name = 'DraftNotAllowedError';
  }
}

export interface DraftResult {
  /** '' whenever there is nothing worth showing — the browser then shows nothing. */
  readonly text: string;
  /** True when the organisation has switched drafting off entirely. */
  readonly disabled: boolean;
}

const NOTHING: DraftResult = { text: '', disabled: false };
const OFF: DraftResult = { text: '', disabled: true };

export async function suggestFieldDraft(input: SuggestInput): Promise<DraftResult> {
  const spec = fieldDraftSpec(input.field);
  if (!spec.suggest) throw new DraftNotAllowedError(input.field);
  if (!await aiFieldDraftsEnabledForTenant(input.tenantId)) return OFF;

  const reply = await generateJson<Reply>({
    fn: 'field_draft',
    // Someone is waiting at a text box on an HR screen, like a JD draft.
    purpose: 'authoring',
    system: SUGGEST_SYSTEM,
    user: JSON.stringify({
      field: spec.label,
      whatThisFieldIsFor: spec.guidance,
      maxCharacters: spec.maxChars,
      context: bounded(input.context),
    }),
    validate: (raw) => replySchema.parse(raw),
    temperature: 0.4,
    maxTokens: tokenCeiling(spec.maxChars),
    timeoutMs: DRAFT_TIMEOUT_MS,
    // Never the local fallback: a 3B model on a CPU writes text that reads as
    // filler, and filler in a job advert costs more than an empty box.
    local: 'built-in',
  });
  if (!reply || !reply.confident) return NOTHING;
  return { text: shapeDraft(reply.text, spec), disabled: false };
}

export interface TidyInput {
  readonly tenantId: string;
  readonly field: DraftFieldKey;
  /** What the person wrote. Nothing is tidied until they have written something. */
  readonly text: string;
}

/** Below this there is nothing to tidy, and a rewrite would be an invention. */
export const MIN_TIDY_CHARS = 20;

export async function tidyFieldText(input: TidyInput): Promise<DraftResult> {
  const spec = fieldDraftSpec(input.field);
  if (!spec.tidy) throw new DraftNotAllowedError(input.field);
  if (input.text.trim().length < MIN_TIDY_CHARS) return NOTHING;
  if (!await aiFieldDraftsEnabledForTenant(input.tenantId)) return OFF;

  const reply = await generateJson<Reply>({
    fn: 'field_tidy',
    purpose: 'authoring',
    system: TIDY_SYSTEM,
    user: JSON.stringify({
      field: spec.label,
      rule: spec.guidance,
      maxCharacters: spec.maxChars,
      theirText: input.text.slice(0, spec.maxChars),
    }),
    validate: (raw) => replySchema.parse(raw),
    // Low: tidying is a faithful rewrite, and invention is the failure mode.
    temperature: 0.1,
    maxTokens: tokenCeiling(spec.maxChars),
    timeoutMs: DRAFT_TIMEOUT_MS,
    local: 'built-in',
  });
  if (!reply || !reply.confident) return NOTHING;
  const tidied = shapeDraft(reply.text, spec);
  // A "tidy" that changed nothing is not worth a before-and-after panel.
  if (tidied === input.text.trim()) return NOTHING;
  return { text: tidied, disabled: false };
}
