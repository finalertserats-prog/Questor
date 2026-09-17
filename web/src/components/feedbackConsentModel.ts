import { formatDate } from './dateFormat';

/**
 * What the recruiter's feedback panel says about the candidate's consent.
 *
 * Feedback is sent only to a candidate who said yes. The server decides and
 * words the reasons (services/candidateFeedbackPolicy.ts); this turns them into
 * a label, a disabled button with its reason, and whether asking is possible.
 */

export type FeedbackConsentStatus = 'OPTED_IN' | 'DECLINED' | 'NOT_ASKED';

/** As GET /api/assessments/:id/feedback reports it under `consent`. */
export interface FeedbackConsent {
  readonly status: FeedbackConsentStatus;
  readonly canSend: boolean;
  readonly blockReason: string | null;
  readonly canRequest: boolean;
  readonly requestBlockReason: string | null;
  readonly request: { readonly issuedAt: string; readonly expiresAt: string } | null;
}

export type ConsentTone = 'pass' | 'stop' | 'hold';

export interface ConsentSummary {
  readonly label: string;
  readonly tone: ConsentTone;
  readonly detail: string;
}

export function consentSummary(consent: FeedbackConsent): ConsentSummary {
  switch (consent.status) {
    case 'OPTED_IN':
      return { label: 'Candidate opted in', tone: 'pass', detail: 'They asked for written feedback. Send it once it is approved.' };
    case 'DECLINED':
      return { label: 'Candidate declined', tone: 'stop', detail: 'They do not want written feedback. Do not email them about it.' };
    case 'NOT_ASKED': {
      const waiting = consent.request
        ? ` A request was sent on ${formatDate(consent.request.issuedAt)}; its link works until ${formatDate(consent.request.expiresAt)}.`
        : '';
      return {
        label: 'Candidate was not asked',
        tone: 'hold',
        detail: `No answer is on file, and feedback is only sent to a candidate who says yes.${waiting}`,
      };
    }
    default: {
      const unreachable: never = consent.status;
      return unreachable;
    }
  }
}

export interface ActionState {
  readonly disabled: boolean;
  readonly reason: string | null;
}

export function sendAction(opts: {
  consent: FeedbackConsent;
  feedbackStatus: string | null;
  busy: boolean;
}): ActionState {
  if (opts.feedbackStatus === 'SENT') return { disabled: true, reason: 'Already sent.' };
  // Consent first: approving does nothing for a candidate who was not asked or
  // said no, and a button that says "approve first" would suggest it does.
  if (!opts.consent.canSend) {
    return { disabled: true, reason: opts.consent.blockReason ?? 'This feedback cannot be sent.' };
  }
  if (opts.feedbackStatus !== 'APPROVED') return { disabled: true, reason: 'Approve the feedback before sending it.' };
  return { disabled: opts.busy, reason: null };
}

export interface RequestActionState {
  readonly visible: boolean;
  readonly label: string;
  readonly note: string | null;
}

export function requestAction(consent: FeedbackConsent): RequestActionState {
  const label = consent.request ? 'Send the request again' : 'Ask the candidate';
  if (consent.canRequest) return { visible: true, label, note: null };
  // Only a never-asked candidate gets an explanation. For the other two the
  // consent summary already says everything, and a note about asking a
  // candidate who declined would read as an invitation to.
  return { visible: false, label, note: consent.status === 'NOT_ASKED' ? consent.requestBlockReason : null };
}
