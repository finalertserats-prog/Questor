import { describe, it, expect } from 'vitest';
import {
  awaitingSummary, homePathForRole, isSmeRole, smeRecommendationLabel, smeReviewProblem,
  SME_ADVISORY_NOTE, SME_FEEDBACK_MIN,
} from '../src/components/smeModel';

const ENOUGH = 'x'.repeat(SME_FEEDBACK_MIN);

describe('smeRecommendationLabel', () => {
  it('says Proceed', () => {
    expect(smeRecommendationLabel('proceed')).toBe('Proceed');
  });

  it('says Do not proceed', () => {
    expect(smeRecommendationLabel('do_not_proceed')).toBe('Do not proceed');
  });

  // A newer server may record a word this build has never heard of. Showing it
  // unchanged is honest; showing "Unknown" would hide a real recommendation.
  it('passes an unrecognised value through rather than inventing a label', () => {
    expect(smeRecommendationLabel('hold')).toBe('hold');
  });
});

describe('smeReviewProblem', () => {
  it('accepts a recommendation with reasoning behind it', () => {
    expect(smeReviewProblem('proceed', ENOUGH)).toBeNull();
  });

  it('asks for a choice when none was made', () => {
    expect(smeReviewProblem('', ENOUGH)).toContain('whether you would proceed');
  });

  // The verdict vocabulary belongs to a review the pipeline acts on; the server
  // refuses it too, and the form should not be the place that discovers this.
  it('refuses the reviewer\'s verdict vocabulary', () => {
    expect(smeReviewProblem('PROCEED', ENOUGH)).not.toBeNull();
  });

  it('asks for reasoning when there is none', () => {
    expect(smeReviewProblem('proceed', 'Good.')).toContain('Say why');
  });

  it('counts the reasoning after trimming, so whitespace is not an argument', () => {
    expect(smeReviewProblem('proceed', `   ${'y'.repeat(SME_FEEDBACK_MIN - 5)}   `)).not.toBeNull();
  });

  it('refuses reasoning longer than the form can take', () => {
    expect(smeReviewProblem('proceed', 'z'.repeat(5001))).toContain('shorten');
  });
});

describe('where a signed-in person lands', () => {
  // An expert has no dashboard, no pipeline and no candidate list. Landing them
  // on `/` means three requests that are already known to be refused, and then
  // nothing on the screen.
  it('sends an expert to their worklist', () => {
    expect(homePathForRole('sme')).toBe('/sme');
  });

  it('leaves everyone else where they were', () => {
    for (const role of ['recruiter', 'manager', 'reviewer', 'auditor', 'admin']) {
      expect(homePathForRole(role)).toBe('/');
    }
  });

  it('knows which role the expert surface belongs to', () => {
    expect([isSmeRole('sme'), isSmeRole('reviewer')]).toEqual([true, false]);
  });
});

describe('awaitingSummary', () => {
  // Nothing outstanding has nothing to say, and an empty sentence is how the
  // caller knows to render nothing rather than an empty row.
  it('says nothing when nobody is outstanding', () => {
    expect(awaitingSummary([])).toBe('');
  });

  it('names one', () => {
    expect(awaitingSummary([{ userId: 'u1', name: 'Priya' }])).toBe('Priya has been asked and has not answered yet.');
  });

  it('joins two with "and"', () => {
    expect(awaitingSummary([{ userId: 'u1', name: 'Priya' }, { userId: 'u2', name: 'Arun' }]))
      .toBe('Priya and Arun have been asked and have not answered yet.');
  });

  it('commas all but the last of three', () => {
    expect(awaitingSummary([{ userId: 'u1', name: 'Priya' }, { userId: 'u2', name: 'Arun' }, { userId: 'u3', name: 'Mei' }]))
      .toBe('Priya, Arun and Mei have been asked and have not answered yet.');
  });
});

describe('the advisory note', () => {
  // It is the one thing that must appear beside a recommendation everywhere it
  // is shown, so it is a constant rather than a sentence each page writes.
  it('says the recommendation moves nobody', () => {
    expect(SME_ADVISORY_NOTE).toContain('moves nobody');
  });
});
