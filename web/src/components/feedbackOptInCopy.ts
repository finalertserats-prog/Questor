/**
 * What a candidate reads when asked whether they want written feedback — at the
 * end of their interview (InterviewRoom) and on the page an emailed request
 * links to (FeedbackConsent). One set of words for both, so the promise is the
 * same wherever the question is asked.
 *
 * The server keeps these promises: feedback is sent only after an explicit yes
 * (server/src/services/candidateFeedbackPolicy.ts, and since 23 September 2026
 * services/autoFeedbackModel.ts too — the automatic letter used to go to a
 * candidate who never answered, which made "if you do not answer, we will not
 * send you any feedback" untrue), and the first answer is the one kept.
 *
 * The explanation below said a person writes the note. Often nobody does:
 * Questor writes it from the interview and a reviewer's corrections are folded
 * in if a review lands first (server/src/services/autoFeedback.ts). The words
 * now say which it is, because "someone on the hiring team writes it" was a
 * promise about authorship that the product does not keep.
 */

export const FEEDBACK_QUESTION = 'Would you like written feedback on your interview by email?';

export const FEEDBACK_EXPLANATION = 'If you say yes, we email you a short note on how the interview went: what '
  + 'came through well and what would be worth working on. It is written from your interview — by Questor, or by '
  + 'someone on the hiring team, depending on how this organisation works — and it may take a few days. We only '
  + 'send feedback if you say yes. Saying no, or not answering, does not affect how your application is considered.';

export const FEEDBACK_YES_LABEL = 'Yes, email me feedback';
export const FEEDBACK_NO_LABEL = 'No, thank you';

export function answerConfirmation(choice: string): string {
  return choice === 'YES'
    ? 'Thank you. We have noted that you would like written feedback, and we will email it to you.'
    : 'Thank you. We have noted that you do not want written feedback. We will not send you any.';
}

export const ALREADY_ANSWERED = 'We already have your answer to this question, so nothing has changed. '
  + 'If you would like to change it, reply to the email this link came in and someone will help.';
