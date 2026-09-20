/**
 * What the assessment page says about the candidate's automatic feedback
 * email, kept free of React (web/tests/feedbackEmailModel.test.ts). The server
 * decides whether "Send feedback now" is allowed and words the reasons
 * (server/src/services/autoFeedback.ts); this turns that into a headline, a
 * detail line and which controls to show.
 */

/** As GET /api/assessments/:id/feedback-email reports the row. */
export interface FeedbackEmailRecord {
  readonly status: string;
  readonly trigger: string;
  readonly skipReason: string;
  readonly skipReasonText: string | null;
  readonly attempts: number;
  readonly lastError: string;
  readonly subject: string;
  readonly bodyText: string;
  readonly contentSource: string;
  readonly delivered: boolean;
  readonly sentAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
}

export interface FeedbackEmailState {
  readonly email: FeedbackEmailRecord | null;
  readonly canSendNow: boolean;
  readonly blockedReason: string | null;
  /** The server will send again only if someone accepts the risk of a duplicate. */
  readonly needsDuplicateConfirmation?: boolean;
}

export type FeedbackEmailTone = 'sent' | 'unverified' | 'pending' | 'failed' | 'none';

export interface FeedbackEmailSummary {
  readonly tone: FeedbackEmailTone;
  readonly headline: string;
  readonly detail: string | null;
  /** Whether "View" can show the text the candidate received. */
  readonly showText: boolean;
  readonly canSendNow: boolean;
  /** Sending again is possible, but only after the duplicate risk is accepted. */
  readonly needsDuplicateConfirmation: boolean;
}

const NOT_SENT = 'No feedback email has been sent to the candidate yet';

export function feedbackEmailSummary(state: FeedbackEmailState, formatDate: (iso: string) => string): FeedbackEmailSummary {
  const email = state.email;
  const base = {
    canSendNow: state.canSendNow,
    showText: false,
    needsDuplicateConfirmation: state.needsDuplicateConfirmation === true,
  };
  if (!email || email.status === 'DRAFT') {
    return { ...base, tone: 'none', headline: NOT_SENT, detail: state.canSendNow ? null : state.blockedReason };
  }
  switch (email.status) {
    case 'SENT': {
      // Honest about a server that only logs mail: "sent" alone would tell
      // the hiring team the candidate has it when nobody does.
      const detail = !email.delivered
        ? 'Email is not set up to deliver on this server, so the message was only logged. Share it with the candidate yourself.'
        : email.trigger === 'manual' ? 'Sent from this page by a member of the hiring team.' : null;
      return {
        ...base, tone: 'sent', showText: true, detail,
        headline: `Feedback sent to the candidate on ${email.sentAt ? formatDate(email.sentAt) : 'an unknown date'}`,
      };
    }
    // Not a failure and not a confirmed send: the candidate probably has it.
    // Saying "could not be sent" here is how someone ends up sending a second
    // copy of their feedback.
    case 'SENT_UNVERIFIED':
      return {
        ...base, tone: 'unverified', showText: Boolean(email.bodyText),
        headline: 'The feedback email may have reached the candidate',
        detail: email.lastError || state.blockedReason,
      };
    case 'QUEUED':
    case 'SENDING':
      return {
        ...base, tone: 'pending', headline: 'Feedback email is on its way to the candidate',
        detail: email.attempts > 0 && email.lastError
          ? `The last try did not go through (${email.lastError}). It will be tried again automatically.`
          : null,
      };
    case 'FAILED':
      return { ...base, tone: 'failed', headline: 'The feedback email could not be sent', detail: email.lastError || null };
    case 'SKIPPED':
      return { ...base, tone: 'none', headline: 'No feedback email was sent', detail: email.skipReasonText ?? state.blockedReason };
    default:
      return { ...base, tone: 'none', headline: NOT_SENT, detail: state.blockedReason };
  }
}
