import { describe, it, expect } from 'vitest';
import { accommodationRequestOf, interviewActions } from '../src/components/interviewActionsModel';

const RECRUITER = { capabilities: ['interview:schedule', 'interview:invite', 'interview:drive', 'candidate:read'] };
const REVIEWER = { capabilities: ['candidate:read', 'interview:read', 'assessment:read', 'assessment:review'] };
const ALL_STATE = { cancel: true, schedule: true, retake: true, assessPartial: true, reopen: true, sendInvitation: true, resend: true };
const NONE = { cancel: false, schedule: false, retake: false, assessPartial: false, reopen: false, sendInvitation: false, resend: false };

describe('interviewActions', () => {
  it('offers what the state allows to someone who may do it', () => {
    expect(interviewActions('INCOMPLETE', ALL_STATE, RECRUITER)).toEqual({ ...ALL_STATE, invite: true });
  });

  it('offers nothing to a reviewer, who cannot run interviews', () => {
    expect(interviewActions('INCOMPLETE', ALL_STATE, REVIEWER)).toEqual({ ...NONE, invite: false });
  });

  it('follows the server when the state forbids cancelling', () => {
    expect(interviewActions('CONSENTED', { ...ALL_STATE, cancel: false }, RECRUITER).cancel).toBe(false);
  });

  it('follows the server when the state forbids a resend', () => {
    expect(interviewActions('CANCELLED', NONE, RECRUITER).resend).toBe(false);
  });

  it('lets an accepted interview be cancelled when the server sends no actions', () => {
    expect(interviewActions('ACCEPTED', undefined, RECRUITER).cancel).toBe(true);
  });

  it('does not offer cancel for a handed-off interview when the server sends no actions', () => {
    expect(interviewActions('MANUAL_HANDOFF', undefined, RECRUITER).cancel).toBe(false);
  });

  it('does not offer a resend for a cancelled interview when the server sends no actions', () => {
    expect(interviewActions('CANCELLED', undefined, RECRUITER).resend).toBe(false);
  });
});

describe('accommodationRequestOf', () => {
  it('reads the request and when it was made', () => {
    expect(accommodationRequestOf({ accommodationRequest: ' Extra time, please ', accommodationRequestedAt: '2026-09-20T10:00:00.000Z' }))
      .toEqual({ text: 'Extra time, please', requestedAt: '2026-09-20T10:00:00.000Z' });
  });

  it('is null when there is none', () => {
    expect(accommodationRequestOf({ disclosureText: 'x' })).toBeNull();
  });

  it('is null for a consent record that is not an object', () => {
    expect(accommodationRequestOf('damaged')).toBeNull();
  });
});
