import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REVIEW_WINDOW_HOURS, HIRING_POLICY_TOGGLES, hiringPolicySwitches, policyPatch,
  reviewWindowField, reviewWindowPatch,
} from '../src/components/hiringPolicyModel';

describe('the review window', () => {
  it('shows twelve hours when the organisation has not chosen', () => {
    expect(reviewWindowField({})).toEqual({ hours: DEFAULT_REVIEW_WINDOW_HOURS, chosen: false });
  });

  it('shows the hours the organisation chose', () => {
    expect(reviewWindowField({ feedbackReviewWindowHours: 4 })).toEqual({ hours: 4, chosen: true });
  });

  it('ignores a value that is not a sensible number of hours', () => {
    expect(reviewWindowField({ feedbackReviewWindowHours: 400 })).toEqual({ hours: DEFAULT_REVIEW_WINDOW_HOURS, chosen: false });
  });

  it('saves the window on its own', () => {
    expect(reviewWindowPatch(6)).toEqual({ policy: { feedbackReviewWindowHours: 6 } });
  });

  it('refuses to save a window nobody could defend', () => {
    expect(reviewWindowPatch(500)).toBeNull();
  });

  it('allows no wait at all', () => {
    expect(reviewWindowPatch(0)).toEqual({ policy: { feedbackReviewWindowHours: 0 } });
  });
});

describe('who signs the candidate letter', () => {
  it('is Questor unless the organisation says otherwise', () => {
    expect(hiringPolicySwitches({}).feedbackSignedByCompany).toBe(false);
  });

  it('is the organisation once they have asked', () => {
    expect(hiringPolicySwitches({ feedbackSignedByCompany: true }).feedbackSignedByCompany).toBe(true);
  });

  it('is offered as a switch, in words an admin recognises', () => {
    expect(HIRING_POLICY_TOGGLES.find((t) => t.key === 'feedbackSignedByCompany')?.label)
      .toBe('Sign candidate feedback as your organisation instead of Questor');
  });
});

/**
 * The two admin switches for how a finished interview is handled. The
 * defaults must match the server's (services/autoFeedbackModel.ts): an unset
 * policy sends feedback automatically and does not require a blind review.
 */

describe('reading the switches', () => {
  it('shows automatic feedback as on when the policy says nothing', () => {
    expect(hiringPolicySwitches({}).autoCandidateFeedback).toBe(true);
  });

  it('shows automatic feedback as off only after an explicit false', () => {
    expect(hiringPolicySwitches({ autoCandidateFeedback: false }).autoCandidateFeedback).toBe(false);
  });

  it('shows the blind review as not required when the policy says nothing', () => {
    expect(hiringPolicySwitches({}).requireBlindReview).toBe(false);
  });

  it('shows the blind review as required only after an explicit true', () => {
    expect(hiringPolicySwitches({ requireBlindReview: true }).requireBlindReview).toBe(true);
  });

  it('does not read a malformed value as required', () => {
    expect(hiringPolicySwitches({ requireBlindReview: 'true' }).requireBlindReview).toBe(false);
  });
});

describe('the toggles', () => {
  it('labels automatic feedback in the words the owner asked for', () => {
    expect(HIRING_POLICY_TOGGLES.find((t) => t.key === 'autoCandidateFeedback')?.label)
      .toBe('Email candidates feedback automatically after the interview');
  });

  it('labels the blind review in the words the owner asked for', () => {
    expect(HIRING_POLICY_TOGGLES.find((t) => t.key === 'requireBlindReview')?.label)
      .toBe('Require an independent review before showing AI scores');
  });

  it('saves only the switch that changed', () => {
    expect(policyPatch('requireBlindReview', true)).toEqual({ policy: { requireBlindReview: true } });
  });
});
