import type { JourneyCandidateFeedback, JourneyFeedbackView } from './candidateJourney';

// The candidate-feedback part of the journey board, kept apart from
// candidateJourney.ts so that file stays within the size limit.

/**
 * The candidate's own feedback decision, in sentences a recruiter can act on.
 *
 * "Not asked" is stated as its own outcome rather than shown as a decline. The
 * two lead to opposite actions — one means someone may still ask, the other
 * means nobody may email — and a UI that renders them alike is how a candidate
 * who said no ends up contacted anyway. Neither can be sent feedback: only a
 * yes can.
 */
function approvedLabel(answered: boolean, wantsFeedback: boolean): string {
  if (wantsFeedback) return 'Approved and waiting to be sent.';
  return answered
    ? 'Approved, but it cannot be sent: the candidate declined.'
    : 'Approved, but it cannot be sent until the candidate says yes.';
}

export function buildFeedbackView(feedback: JourneyCandidateFeedback | null): JourneyFeedbackView {
  const optIn = feedback?.optIn ?? null;
  const draft = feedback?.draft ?? null;
  const humanRequest = feedback?.humanRequest ?? null;

  const answered = Boolean(optIn);
  const wantsFeedback = optIn?.choice === 'YES';

  const answerLabel = !answered
    ? 'Not asked, or no answer given. This is not a refusal, but feedback is only sent after they say yes. '
      + 'You can ask them from the assessment page.'
    : wantsFeedback
      ? 'Asked us for written feedback by email.'
      : 'Declined written feedback. Do not email them about it.';

  const status = draft?.status ?? null;
  const draftLabel = status === 'DRAFT'
    ? 'A draft is waiting for someone to read, edit and approve it.'
    : status === 'APPROVED'
      ? approvedLabel(answered, wantsFeedback)
      : status === 'SENT'
        ? 'Sent to the candidate.'
        : wantsFeedback
          ? 'They asked for feedback, but no draft exists yet.'
          : 'No draft.';

  const humanRequestLabel = humanRequest?.requested
    ? 'This candidate has asked to speak to a person about their feedback.'
    : 'No request to speak to anyone.';

  return {
    answered,
    wantsFeedback,
    answerLabel,
    decidedAt: optIn?.decidedAt ?? null,
    // Only a DRAFT is genuinely waiting on a human. Approved and sent are not
    // someone's outstanding task.
    draftWaiting: status === 'DRAFT',
    draftLabel,
    draftHref: draft?.assessmentId ? `/assessments/${draft.assessmentId}` : null,
    humanRequested: Boolean(humanRequest?.requested),
    humanRequestedAt: humanRequest?.requestedAt ?? null,
    humanRequestLabel,
  };
}
