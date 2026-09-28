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

/**
 * What the server said about a send it has just done.
 *
 * `delivered` is the verdict and `deliveryNote` is the sentence written for the
 * recruiter — including, when the provider does not deliver, an explicit
 * instruction to copy the link and send it themselves.
 */
export interface SendReport {
  readonly delivered?: boolean;
  readonly deliveryNote?: string;
}

/** A green toast, or a banner the recruiter has to deal with. */
export type SendOutcome =
  | { readonly kind: 'toast'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

const CANNOT_CONFIRM = 'The invitation link was created, but we could not confirm the email was sent. Copy the link and send it yourself.';
const UNDELIVERED = 'The invitation link was created, but the email was not sent. Copy the link and send it yourself.';

/**
 * Report a send exactly as the server reported it.
 *
 * Pressing Invite used to toast a hardcoded "Invitation created." whatever came
 * back, so an undelivered invitation read as a success and nobody found out
 * until someone asked why the candidate had gone quiet. Anything short of an
 * explicit `delivered: true` is raised rather than toasted: a reply with no
 * verdict is not a verdict of success, and a silent failure here costs a
 * candidate their interview.
 */
export function sendOutcome(report: SendReport | null | undefined, fallback: string): SendOutcome {
  if (report?.delivered === true) return { kind: 'toast', message: report.deliveryNote?.trim() || fallback };
  const unknown = report?.delivered === undefined;
  return { kind: 'error', message: report?.deliveryNote?.trim() || (unknown ? CANNOT_CONFIRM : UNDELIVERED) };
}

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
