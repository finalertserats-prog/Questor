/**
 * The admin switches for what happens after an interview, kept free of React
 * so the defaults are tested (web/tests/hiringPolicyModel.test.ts).
 *
 * The defaults mirror the server's (server/src/services/autoFeedbackModel.ts):
 * a policy written before a switch existed says nothing about it, and the
 * console must show what the server will actually do in that case.
 */

export type HiringPolicyKey = 'autoCandidateFeedback' | 'requireBlindReview' | 'feedbackSignedByCompany' | 'aiFieldDrafts';

/** Mirrors the server's DEFAULT_REVIEW_WINDOW_HOURS (services/autoFeedbackModel.ts). */
export const DEFAULT_REVIEW_WINDOW_HOURS = 12;
const MAX_REVIEW_WINDOW_HOURS = 168;

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
    key: 'feedbackSignedByCompany',
    label: 'Sign candidate feedback as your organisation instead of Questor',
    help: 'By default the letter is signed "The Questor team" and the footer says it was sent on your behalf. '
      + 'Switch this on to sign it as your own hiring team.',
  },
  {
    key: 'aiFieldDrafts',
    label: 'Offer AI-drafted suggestions in text fields',
    help: 'A suggested draft under the box when someone is writing a job description, a competency or a message '
      + 'to a candidate, and "tidy up what I wrote" on their own notes. Nothing is ever drafted for a reviewer’s '
      + 'verdict, their evidence notes or a reason for changing a level — those are the record of a human '
      + 'judgement, and no switch turns that on. Switch this off if your organisation does not allow '
      + 'AI-generated text in hiring.',
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
    feedbackSignedByCompany: policy.feedbackSignedByCompany === true,
    // On unless switched off: drafting is offered only on authoring fields,
    // and never taken without the person pressing something
    // (server/src/services/fieldDraftPolicy.ts).
    aiFieldDrafts: policy.aiFieldDrafts !== false,
  };
}

export interface ReviewWindowField {
  readonly hours: number;
  /** False when the deployment default is being shown rather than a choice. */
  readonly chosen: boolean;
}

/**
 * How long the hiring team has to review before the candidate's feedback goes
 * on its own. Anything the server would refuse is shown as the default rather
 * than echoed back as if it had been saved.
 */
export function reviewWindowField(policy: Readonly<Record<string, unknown>>): ReviewWindowField {
  const hours = policy.feedbackReviewWindowHours;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 0 || hours > MAX_REVIEW_WINDOW_HOURS) {
    return { hours: DEFAULT_REVIEW_WINDOW_HOURS, chosen: false };
  }
  return { hours, chosen: true };
}

/** The body for PUT /api/admin/policy, or null when the number is not one to send. */
export function reviewWindowPatch(hours: number): { policy: { feedbackReviewWindowHours: number } } | null {
  if (!Number.isInteger(hours) || hours < 0 || hours > MAX_REVIEW_WINDOW_HOURS) return null;
  return { policy: { feedbackReviewWindowHours: hours } };
}

/** The body for PUT /api/admin/policy. The server merges it, so only the changed switch is sent. */
export function policyPatch(key: HiringPolicyKey, value: boolean): { policy: Partial<Record<HiringPolicyKey, boolean>> } {
  return { policy: { [key]: value } };
}
