import { describe, it, expect } from 'vitest';
import { actionFor, compareNeedsYou, initialsOf, isUrgent, mayActOn, maySee, NEEDS_YOU_KINDS, type NeedsYouKind } from '../src/domain/needsYou.js';
import { capabilitiesOf } from '../src/domain/capabilities.js';

const ctxFor = (role: string, extra: { operator?: boolean; platformOperator?: boolean } = {}) => ({
  capabilities: capabilitiesOf(role), operator: extra.operator ?? false, platformOperator: extra.platformOperator ?? false,
});
const kindsFor = (role: string, extra: { operator?: boolean; platformOperator?: boolean } = {}) =>
  NEEDS_YOU_KINDS.filter((kind) => maySee(kind, ctxFor(role, extra)));

describe('needs-you gating', () => {
  it('gives a hiring manager reviews but not invitation chores it cannot do', () => {
    expect(kindsFor('manager')).toEqual(['human_request', 'accommodation', 'review', 'feedback_held', 'invitation_expiring', 'stalled', 'identity_code_stuck']);
  });

  it('gives a recruiter the invitation chores and the reviews that landed on their candidates', () => {
    expect(kindsFor('recruiter')).toEqual(['human_request', 'accommodation', 'review', 'invitation_expiring', 'stalled', 'identity_code_stuck']);
  });

  it('does not let the recruiter sign a review off, only see it', () => {
    const recruiter = ctxFor('recruiter');
    expect([maySee('review', recruiter), mayActOn('review', recruiter)]).toEqual([true, false]);
  });

  it('lets a hiring manager both see and sign off a review', () => {
    const manager = ctxFor('manager');
    expect([maySee('review', manager), mayActOn('review', manager)]).toEqual([true, true]);
  });

  it('keeps a review from an auditor, who may not read assessments at all', () => {
    expect(maySee('review', ctxFor('auditor'))).toBe(false);
  });

  it('keeps the held feedback letter to whoever may sign it off', () => {
    expect([maySee('feedback_held', ctxFor('recruiter')), maySee('feedback_held', ctxFor('manager'))]).toEqual([false, true]);
  });

  it('gives a reviewer only reviews and people asking for someone', () => {
    expect(kindsFor('reviewer')).toEqual(['human_request', 'review', 'feedback_held']);
  });

  it('gives an auditor nothing', () => {
    expect(kindsFor('auditor')).toEqual([]);
  });

  it('adds the catalog queue only for the platform owner', () => {
    expect(kindsFor('admin', { platformOperator: true })).toContain('catalog_proposals');
  });

  it('keeps the catalog queue from an organisation admin', () => {
    expect(kindsFor('admin')).not.toContain('catalog_proposals');
  });

  it('adds demo requests only for the deployment operator', () => {
    expect(kindsFor('admin', { operator: true })).toContain('demo_request');
  });
});

describe('needs-you ordering', () => {
  const row = (kind: NeedsYouKind, since: string, id = kind) => ({ kind, since, id });

  it('puts a person asking for someone ahead of an older review', () => {
    const rows = [row('review', '2026-09-01T00:00:00.000Z'), row('human_request', '2026-09-20T00:00:00.000Z')];
    expect([...rows].sort(compareNeedsYou).map((r) => r.kind)).toEqual(['human_request', 'review']);
  });

  it('puts the longest wait first among equals', () => {
    const rows = [row('review', '2026-09-20T00:00:00.000Z', 'b'), row('stalled', '2026-09-10T00:00:00.000Z', 'a')];
    expect([...rows].sort(compareNeedsYou).map((r) => r.kind)).toEqual(['stalled', 'review']);
  });

  it('breaks a tie on the id so the order is stable', () => {
    const at = '2026-09-20T00:00:00.000Z';
    const rows = [row('review', at, 'z'), row('review', at, 'a')];
    expect([...rows].sort(compareNeedsYou).map((r) => r.id)).toEqual(['a', 'z']);
  });

  it('treats an accommodation request as urgent', () => {
    expect(isUrgent('accommodation')).toBe(true);
  });
});

describe('needs-you actions', () => {
  it('sends a review to its assessment', () => {
    expect(actionFor('review', { sessionId: 's1', assessmentId: 'a1' })).toEqual({ label: 'Review', to: '/assessments/a1' });
  });

  it('offers the assessment to read, not a verdict to record, to someone who cannot sign it off', () => {
    expect(actionFor('review', { sessionId: 's1', assessmentId: 'a1' }, false)).toEqual({ label: 'Open the assessment', to: '/assessments/a1' });
  });

  it('falls back to the interview when a review has no assessment id', () => {
    expect(actionFor('review', { sessionId: 's1', assessmentId: null }).to).toBe('/interviews/s1');
  });

  it('sends an expiring invitation to its interview, where it can be resent', () => {
    expect(actionFor('invitation_expiring', { sessionId: 's1' })).toEqual({ label: 'Resend invitation', to: '/interviews/s1' });
  });

  it('has no page for a demo request, which is decided from the email', () => {
    expect(actionFor('demo_request', {}).to).toBeNull();
  });
});

describe('initialsOf', () => {
  it('takes the first and last word', () => {
    expect(initialsOf('Rahul Kumar Verma')).toBe('RV');
  });

  it('answers "?" for a blank name', () => {
    expect(initialsOf('  ')).toBe('?');
  });
});
