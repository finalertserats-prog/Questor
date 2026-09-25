import { readTenantPolicy } from './candidateFeedbackPolicy.js';

/**
 * Whether this organisation allows the product to draft text for its people.
 *
 * Some customers forbid AI-generated text anywhere in hiring — a policy
 * position, not a preference — so one switch turns every suggestion and every
 * "tidy up" in the product off at the server, not merely out of the UI.
 *
 * Default ON, because drafting is offered only on authoring fields where the
 * person is writing a job advert or a message, and the draft is never taken
 * without them pressing something. The judgement-field boundary
 * (domain/fieldDrafts.ts) is NOT this switch: that one cannot be turned on.
 */

export const AI_FIELD_DRAFTS_KEY = 'aiFieldDrafts';

/** Pure, so the default is testable without a database. Unset means on. */
export function aiFieldDraftsEnabled(policy: Readonly<Record<string, unknown>>): boolean {
  return policy[AI_FIELD_DRAFTS_KEY] !== false;
}

export async function aiFieldDraftsEnabledForTenant(tenantId: string): Promise<boolean> {
  return aiFieldDraftsEnabled(await readTenantPolicy(tenantId));
}
