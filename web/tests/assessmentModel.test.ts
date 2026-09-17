import { describe, it, expect } from 'vitest';
import {
  DISPOSITIONS, canSubmitVerdict, exportStatusSentence, isDisposition, isScored,
} from '../src/components/assessmentModel';

describe('exportStatusSentence', () => {
  it('says what a queued export means', () => {
    expect(exportStatusSentence('QUEUED')).toBe('Queued for export to your ATS.');
  });

  it('explains a skipped export rather than leaving the reader to guess', () => {
    expect(exportStatusSentence('SKIPPED')).toContain('no ATS is configured');
  });

  it('offers a way forward when the export failed', () => {
    expect(exportStatusSentence('FAILED')).toContain('Try again');
  });

  // The token the server's ATS export actually returns.
  it('says an exported assessment reached the ATS', () => {
    expect(exportStatusSentence('exported')).toBe('Sent to your ATS.');
  });

  it('reads the status whatever case it arrives in', () => {
    expect(exportStatusSentence(' sent ')).toBe('Sent to your ATS.');
  });

  // A token nobody planned for is still information; it is shown, not hidden.
  it('shows an unrecognised status as it came', () => {
    expect(exportStatusSentence('PARTIAL')).toBe('Export status: PARTIAL');
  });
});
import { recommendationStatus } from '../src/components/statusModel';

describe('isDisposition', () => {
  it('accepts each verdict a reviewer may record', () => {
    expect(DISPOSITIONS.every(isDisposition)).toBe(true);
  });

  it('rejects the empty choice, which is what an unanswered form holds', () => {
    expect(isDisposition('')).toBe(false);
  });

  // The AI says this when grading never ran. It is not a verdict a person can
  // record, so it must not reach the disposition field.
  it('rejects the scoring-unavailable recommendation', () => {
    expect(isDisposition('SCORING_UNAVAILABLE')).toBe(false);
  });

  it('rejects anything else the server might send', () => {
    expect(isDisposition('MAYBE')).toBe(false);
  });
});

describe('isScored', () => {
  it('is true for a real overall score', () => {
    expect(isScored({ overallScore: 76 })).toBe(true);
  });

  it('is true for a genuine zero', () => {
    expect(isScored({ overallScore: 0 })).toBe(true);
  });

  it('is false when grading produced no score', () => {
    expect(isScored({ overallScore: null })).toBe(false);
  });

  it('is false when the result is missing altogether', () => {
    expect(isScored(null)).toBe(false);
  });
});

describe('canSubmitVerdict', () => {
  const ready = { disposition: 'PROCEED', reason: 'Strong evidence on both essentials.', scored: true, submitting: false };

  it('allows a chosen verdict with a reason', () => {
    expect(canSubmitVerdict(ready)).toBe(true);
  });

  // The defect: the form defaulted to CONSIDER, so a verdict could be recorded
  // against an assessment the reviewer had never actually judged.
  it('refuses a verdict nobody chose', () => {
    expect(canSubmitVerdict({ ...ready, disposition: '' })).toBe(false);
  });

  it('refuses a verdict against an assessment with no score', () => {
    expect(canSubmitVerdict({ ...ready, scored: false })).toBe(false);
  });

  it('refuses a reason too short to be one', () => {
    expect(canSubmitVerdict({ ...ready, reason: '  ok ' })).toBe(false);
  });

  it('refuses a second press while the first is still in flight', () => {
    expect(canSubmitVerdict({ ...ready, submitting: true })).toBe(false);
  });
});

describe('the scoring-unavailable recommendation', () => {
  it('reads as a state of the grading, not as a verdict on the candidate', () => {
    expect(recommendationStatus('SCORING_UNAVAILABLE').label).toBe('Scoring unavailable');
  });

  it('carries no pass or fail tone', () => {
    expect(recommendationStatus('SCORING_UNAVAILABLE').tone).toBe('neutral');
  });
});
