import { prisma, parseJsonOptional } from '../db.js';
import { autoCandidateFeedbackEnabled, blindReviewRequired } from './autoFeedbackModel.js';

function truthyBoolean(value: unknown): boolean {
  return value === true;
}

/** The tenant's policy blob, or {} when there is none to read. */
export async function readTenantPolicy(tenantId: string): Promise<Record<string, unknown>> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
  return parseJsonOptional<Record<string, unknown>>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: tenantId, field: 'policyJson' });
}

/** The reviewed draft -> approve -> send flow. Off unless switched on. */
export async function candidateFeedbackEnabledForTenant(tenantId: string): Promise<boolean> {
  return truthyBoolean((await readTenantPolicy(tenantId)).candidateFeedbackEnabled);
}

/** The automatic email after every completed interview. On unless switched off. */
export async function autoCandidateFeedbackEnabledForTenant(tenantId: string): Promise<boolean> {
  return autoCandidateFeedbackEnabled(await readTenantPolicy(tenantId));
}

/** Whether reviewers must judge blind before the assessment opens. Off unless switched on. */
export async function blindReviewRequiredForTenant(tenantId: string): Promise<boolean> {
  return blindReviewRequired(await readTenantPolicy(tenantId));
}

/**
 * Where a candidate stands on written feedback.
 *
 * Only OPTED_IN may be sent anything. NOT_ASKED used to be sendable, on the
 * reasoning that silence is not a refusal. It is not consent either, and an
 * unsolicited email about how someone's interview went is the harm this
 * feature exists to avoid. It covers every interview from before the question
 * was asked, and every interview whose candidate never answered.
 */
export type FeedbackConsentStatus = 'OPTED_IN' | 'DECLINED' | 'NOT_ASKED';

/**
 * Shown to the recruiter as-is, and returned as the send route's error. Two
 * distinct sentences because the two lead to opposite next steps: one can be
 * fixed by asking, the other must be left alone.
 */
export const FEEDBACK_BLOCK_REASONS: Readonly<Record<Exclude<FeedbackConsentStatus, 'OPTED_IN'>, string>> = {
  NOT_ASKED: 'Candidate was not asked whether they want written feedback, so it cannot be sent yet. '
    + 'Send them a request to opt in first.',
  DECLINED: 'Candidate declined written feedback, so it cannot be sent to them.',
};

export function feedbackConsentStatus(optIn: { choice: string } | null): FeedbackConsentStatus {
  if (!optIn) return 'NOT_ASKED';
  // Anything other than an explicit YES blocks. A value this code does not
  // know is not a yes.
  return optIn.choice === 'YES' ? 'OPTED_IN' : 'DECLINED';
}

export function feedbackSendBlockReason(status: FeedbackConsentStatus): string | null {
  return status === 'OPTED_IN' ? null : FEEDBACK_BLOCK_REASONS[status];
}
