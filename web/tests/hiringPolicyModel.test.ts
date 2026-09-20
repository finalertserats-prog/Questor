import { describe, it, expect } from 'vitest';
import { HIRING_POLICY_TOGGLES, hiringPolicySwitches, policyPatch } from '../src/components/hiringPolicyModel';

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
