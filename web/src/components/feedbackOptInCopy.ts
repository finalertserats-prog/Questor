/**
 * What a candidate reads when asked whether they want written feedback — at the
 * end of their interview (InterviewRoom) and on the page an emailed request
 * links to (FeedbackConsent). One set of words for both, so the promise is the
 * same wherever the question is asked.
 *
 * The server keeps these promises: feedback is sent only after an explicit yes
 * (server/src/services/candidateFeedbackPolicy.ts), and the first answer is the
 * one kept.
 */

export const FEEDBACK_QUESTION = 'Would you like written feedback on your interview by email?';

export const FEEDBACK_EXPLANATION = 'If you say yes, someone on the hiring team writes a short note about what '
  + 'went well and what you could work on, checks it, and emails it to you. It is not automatic and may take a few '
  + 'days. We only send feedback if you say yes. Saying no, or not answering, does not affect how your '
  + 'application is considered.';

export const FEEDBACK_YES_LABEL = 'Yes, email me feedback';
export const FEEDBACK_NO_LABEL = 'No, thank you';

export function answerConfirmation(choice: string): string {
  return choice === 'YES'
    ? 'Thank you. We have noted that you would like written feedback. Someone on the hiring team will write it '
      + 'and email it to you.'
    : 'Thank you. We have noted that you do not want written feedback. We will not send you any.';
}

export const ALREADY_ANSWERED = 'We already have your answer to this question, so nothing has changed. '
  + 'If you would like to change it, reply to the email this link came in and someone will help.';
