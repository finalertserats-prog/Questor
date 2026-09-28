import { describe, expect, it } from 'vitest';
import { invitePlan, inviteOutcomes, inviteSummary, type InviteTarget } from '../src/components/bulkInviteModel';

const target = (candidateId: string, interview: InviteTarget['interview'] = null): InviteTarget => ({ candidateId, interview });

describe('invitePlan', () => {
  it('sets up an interview first for someone who has none', () => {
    expect(invitePlan([target('a')])).toMatchObject({ setUp: ['a'], invite: ['a'], skipped: [] });
  });

  it('invites straight away when an interview is waiting to be sent', () => {
    expect(invitePlan([target('a', { id: 's', state: 'PROVISIONED' })])).toMatchObject({ setUp: [], invite: ['a'] });
  });

  it('re-invites after a reschedule', () => {
    expect(invitePlan([target('a', { id: 's', state: 'RESCHEDULE_REQUIRED' })]).invite).toEqual(['a']);
  });

  it('skips someone already invited, saying why', () => {
    expect(invitePlan([target('a', { id: 's', state: 'INVITED' })]).skipped).toEqual([{ candidateId: 'a', reason: 'already invited' }]);
  });

  it('skips someone whose interview has started or finished', () => {
    expect(invitePlan([target('a', { id: 's', state: 'COMPLETED' })]).skipped[0].reason).toBe('interview already under way or done');
  });
});

describe('inviteOutcomes', () => {
  it('reads an emailed invitation as invited', () => {
    const outcomes = inviteOutcomes([{ candidateId: 'a', success: true, invitation: { delivered: true } }], [], []);

    expect(outcomes.get('a')).toEqual({ kind: 'invited', text: 'Invited' });
  });

  it('says when the link was made but no email went', () => {
    const outcomes = inviteOutcomes([{ candidateId: 'a', success: true, invitation: { delivered: false } }], [], []);

    expect(outcomes.get('a')!.kind).toBe('link_only');
  });

  it('keeps the server reason for a refused row', () => {
    const outcomes = inviteOutcomes([{ candidateId: 'a', success: false, error: 'Role is closed' }], [], []);

    expect(outcomes.get('a')).toEqual({ kind: 'failed', text: 'Role is closed' });
  });

  it('reports a failed interview set-up against the person', () => {
    const outcomes = inviteOutcomes([], [], [{ candidateId: 'b', error: 'Role scorecard must be approved' }]);

    expect(outcomes.get('b')!.text).toBe('Role scorecard must be approved');
  });

  it('reports a skipped person with the reason', () => {
    expect(inviteOutcomes([], [{ candidateId: 'c', reason: 'already invited' }], []).get('c')).toEqual({ kind: 'skipped', text: 'Skipped: already invited' });
  });
});

describe('inviteSummary', () => {
  it('counts invited and skipped, grouping reasons', () => {
    const outcomes = inviteOutcomes(
      [{ candidateId: 'a', success: true, invitation: { delivered: true } }, { candidateId: 'b', success: true, invitation: { delivered: true } }],
      [{ candidateId: 'c', reason: 'already invited' }, { candidateId: 'd', reason: 'already invited' }],
      [],
    );

    expect(inviteSummary(outcomes)).toBe('2 invited, 2 skipped: already invited');
  });

  it('counts failures and links not emailed', () => {
    const outcomes = inviteOutcomes(
      [{ candidateId: 'a', success: true, invitation: { delivered: false } }, { candidateId: 'b', success: false, error: 'x' }],
      [], [],
    );

    expect(inviteSummary(outcomes)).toBe('0 invited, 1 link created but not emailed, 1 failed');
  });
});
