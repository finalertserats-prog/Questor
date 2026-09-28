import { describe, it, expect } from 'vitest';
import {
  ASSURANCE_LEVELS, DEFAULT_ASSURANCE_LEVEL, assuranceLevelOf, checksFor, isSelectableLevel,
} from '../src/domain/identityAssurance.js';

// Owner decision 2026-09-22: Standard is on for every organisation and no
// organisation can go below it. Enhanced and Verified are shown, not offered.
describe('identity assurance levels', () => {
  it('defaults every organisation to Standard', () => {
    expect(DEFAULT_ASSURANCE_LEVEL).toBe('standard');
  });

  it('has no level below Standard', () => {
    expect(ASSURANCE_LEVELS.map((l) => l.id)).toEqual(['standard', 'enhanced', 'verified']);
  });

  it('offers only Standard for now', () => {
    expect(ASSURANCE_LEVELS.filter((l) => l.available).map((l) => l.id)).toEqual(['standard']);
  });

  it('reads an organisation with no setting as Standard', () => {
    expect(assuranceLevelOf({})).toBe('standard');
  });

  it('reads a stored level that is not available yet as Standard', () => {
    expect(assuranceLevelOf({ identityAssuranceLevel: 'verified' })).toBe('standard');
  });

  it('reads an unknown stored value as Standard, never as off', () => {
    expect(assuranceLevelOf({ identityAssuranceLevel: 'off' })).toBe('standard');
  });

  it('refuses to let an organisation choose a level that is not available', () => {
    expect([isSelectableLevel('standard'), isSelectableLevel('enhanced'), isSelectableLevel('off')]).toEqual([true, false, false]);
  });

  it('runs the email code and the CV follow-ups at Standard', () => {
    expect(checksFor('standard')).toEqual({ emailCode: true, cvFollowUps: true });
  });
});
