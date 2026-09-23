import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_QUESTION, FEEDBACK_EXPLANATION, FEEDBACK_YES_LABEL, FEEDBACK_NO_LABEL,
  ALREADY_ANSWERED, answerConfirmation,
} from '../src/components/feedbackOptInCopy';

/**
 * The words a candidate reads before deciding. Pinned because each sentence
 * makes a promise the server now keeps: nothing is sent without a yes, and
 * the answer does not affect the application.
 */

describe('the feedback question', () => {
  it('asks about written feedback by email', () => {
    expect(FEEDBACK_QUESTION).toBe('Would you like written feedback on your interview by email?');
  });

  it('says feedback is only sent to someone who says yes', () => {
    expect(FEEDBACK_EXPLANATION).toMatch(/only send feedback if you say yes/);
  });

  /**
   * It used to say "someone on the hiring team writes a short note … checks it
   * … It is not automatic". Often nobody does: the letter is written from the
   * interview by Questor and sent on its own if no review arrives
   * (server/src/services/autoFeedback.ts). That was a promise about authorship
   * the product does not keep, so the words now name both possibilities.
   */
  it('says the note may be written by Questor or by a person, because either can happen', () => {
    expect(FEEDBACK_EXPLANATION).toMatch(/by Questor, or by someone on the hiring team/i);
  });

  it('no longer claims a person always writes it', () => {
    expect(FEEDBACK_EXPLANATION).not.toMatch(/someone on the hiring team writes a short note/i);
  });

  it('no longer claims it is not automatic', () => {
    expect(FEEDBACK_EXPLANATION).not.toMatch(/not automatic/i);
  });

  it('still says what the note is about', () => {
    expect(FEEDBACK_EXPLANATION).toMatch(/what would be worth working on/i);
  });

  it('says neither answer affects the application', () => {
    expect(FEEDBACK_EXPLANATION).toMatch(/Saying no, or not answering, does not affect/);
  });

  it('labels the two choices unambiguously', () => {
    expect([FEEDBACK_YES_LABEL, FEEDBACK_NO_LABEL]).toEqual(['Yes, email me feedback', 'No, thank you']);
  });
});

describe('after answering', () => {
  it('confirms a yes', () => {
    expect(answerConfirmation('YES')).toMatch(/you would like written feedback/);
  });

  it('confirms a no, with the promise not to send any', () => {
    expect(answerConfirmation('NO')).toMatch(/We will not send you any/);
  });

  it('reads anything unexpected as a no, never as a yes', () => {
    expect(answerConfirmation('MAYBE')).toBe(answerConfirmation('NO'));
  });

  it('tells a returning candidate their first answer stands and how to change it', () => {
    expect(ALREADY_ANSWERED).toMatch(/already have your answer.*reply to the email/s);
  });
});
