import { describe, it, expect } from 'vitest';
import { isAwaitingCandidate, isInFlight, isUnderway } from '../src/pages/CandidatesList';

// ACCEPTED means the candidate opened the link and has not started. It is not
// an ending: it stays on the chase list, reads "not started yet", and can
// still be cancelled.
describe('an accepted interview', () => {
  it('is still in flight', () => {
    expect(isInFlight('ACCEPTED')).toBe(true);
  });

  it('is waiting on the candidate', () => {
    expect(isAwaitingCandidate('ACCEPTED')).toBe(true);
  });

  it('is not reported as underway', () => {
    expect(isUnderway('ACCEPTED')).toBe(false);
  });
});
