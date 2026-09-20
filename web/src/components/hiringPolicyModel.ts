/**
 * The admin switches for what happens after an interview, kept free of React
 * so the defaults are tested (web/tests/hiringPolicyModel.test.ts).
 *
 * The defaults mirror the server's (server/src/services/autoFeedbackModel.ts):
 * a policy written before a switch existed says nothing about it, and the
 * console must show what the server will actually do in that case.
 */

export type HiringPolicyKey = 'autoCandidateFeedback' | 'requireBlindReview';

export type HiringPolicySwitches = Readonly<Record<HiringPolicyKey, boolean>>;

export interface HiringPolicyToggle {
  readonly key: HiringPolicyKey;
  readonly label: string;
  readonly help: string;
}

export const HIRING_POLICY_TOGGLES: readonly HiringPolicyToggle[] = [
  {
    key: 'autoCandidateFeedback',
    label: 'Email candidates feedback automatically after the interview',
    help: 'Once a completed interview is assessed, the candidate is emailed a short note from your hiring team: '
      + 'what came across well, what to develop and a practical suggestion. It never includes scores or a decision. '
      + 'Candidates who withdrew, did not finish, or said they do not want feedback are not emailed.',
  },
  {
    key: 'requireBlindReview',
    label: 'Require an independent review before showing AI scores',
    help: 'When on, reviewers must record their own verdict from the evidence (or give a reason to skip) before the '
      + 'assessment opens. When off, the assessment shows straight away and blind review stays available as an option.',
  },
];

/** Automatic feedback is on unless switched off; the blind review is off unless switched on. */
export function hiringPolicySwitches(policy: Readonly<Record<string, unknown>>): HiringPolicySwitches {
  return {
    autoCandidateFeedback: policy.autoCandidateFeedback !== false,
    requireBlindReview: policy.requireBlindReview === true,
  };
}

/** The body for PUT /api/admin/policy. The server merges it, so only the changed switch is sent. */
export function policyPatch(key: HiringPolicyKey, value: boolean): { policy: Partial<Record<HiringPolicyKey, boolean>> } {
  return { policy: { [key]: value } };
}
