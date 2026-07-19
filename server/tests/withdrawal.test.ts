import { describe, it, expect } from 'vitest';
import { detectWithdrawal } from '../src/engines/policyEngine.js';

describe('withdrawal detection', () => {
  // The exact words a real candidate used. Both were ignored.
  it('honours the phrasing a real candidate actually used', () => {
    expect(detectWithdrawal('Well you know what I think I\'m going to end the interview')).toBe(true);
    expect(detectWithdrawal('No I\'m done I don\'t wanna do this to you anymore')).toBe(true);
  });

  it('catches other plain ways of asking to stop', () => {
    for (const s of ['I want to stop', 'can we stop here', "I'm finished", 'end the interview please', "let's finish", 'I would like to quit']) {
      expect(detectWithdrawal(s), s).toBe(true);
    }
  });

  // A false positive ends an interview the candidate can resume; a false
  // negative traps them. But describing past work must not end anything.
  it('does not fire on describing past work', () => {
    for (const s of [
      'We decided to stop the rollout after the incident',
      'The team wanted to end that project early',
      'I helped them finish the migration ahead of schedule',
      'My job was to stop duplicate records being created',
    ]) {
      expect(detectWithdrawal(s), s).toBe(false);
    }
  });
});
