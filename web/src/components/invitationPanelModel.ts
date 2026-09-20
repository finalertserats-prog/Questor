import { humanise } from './statusModel';

/**
 * What the invitation card on the interview page offers, kept free of React
 * (web/tests/invitationPanelModel.test.ts).
 *
 * "Resend email", the recruiter preview of the room and the "check their spam
 * folder" hint only make sense before the candidate has started. The server
 * refuses a resend in any other state (RESENDABLE_STATES in
 * server/src/routes/interviews.ts), and a recruiter who pressed Resend on a
 * finished interview got a 409 for following the page's own suggestion. Once
 * the candidate has started, the card says what happened instead.
 */

/** Mirrors the server's RESENDABLE_STATES: the link starts an interview only from these. */
export const RESENDABLE_STATES: readonly string[] = [
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING', 'DISCLOSURE', 'CONSENTED',
];

const LIVE_STATES: ReadonlySet<string> = new Set(['CONNECTING', 'WARMUP', 'ASSESSING', 'CANDIDATE_QUESTIONS', 'CLOSING']);
const FINISHED_STATES: ReadonlySet<string> = new Set(['REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED']);

/** Why an interview in an exception state has nothing to resend, in plain words. */
const STOPPED_TEXT: Readonly<Record<string, string>> = {
  CANDIDATE_WITHDREW: 'The candidate withdrew from this interview',
  INCOMPLETE: 'This interview stopped part-way',
  CANCELLED: 'This interview was cancelled',
};

export interface InvitationPanelInput {
  readonly state: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly sentAt: string | null;
  readonly openedAt: string | null;
  readonly assessmentId: string | null;
}

export type InvitationPanel =
  | { readonly kind: 'not-started'; readonly canResend: true; readonly showNotOpenedHint: boolean }
  | { readonly kind: 'status'; readonly text: string; readonly assessmentId: string | null };

export function invitationPanel(input: InvitationPanelInput, formatDate: (iso: string) => string): InvitationPanel {
  if (RESENDABLE_STATES.includes(input.state)) {
    return { kind: 'not-started', canResend: true, showNotOpenedHint: Boolean(input.sentAt) && !input.openedAt };
  }
  const status = (text: string): InvitationPanel => ({ kind: 'status', text, assessmentId: input.assessmentId });
  if (LIVE_STATES.has(input.state)) {
    return status(input.startedAt
      ? `The candidate started this interview on ${formatDate(input.startedAt)}.`
      : 'The candidate has started this interview.');
  }
  if (input.state === 'PROCESSING') return status('The candidate finished this interview. The assessment is being prepared.');
  if (FINISHED_STATES.has(input.state) && input.completedAt) {
    return status(`Interview completed on ${formatDate(input.completedAt)}.`);
  }
  const stopped = STOPPED_TEXT[input.state] ?? `This interview is ${humanise(input.state).toLowerCase()}`;
  return status(`${stopped}, so there is no invitation to resend.`);
}
