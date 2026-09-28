import { describe, it, expect } from 'vitest';
import { sendOutcome } from '../src/components/invitationPanelModel';

/**
 * The screen must not contradict the server.
 *
 * Pressing Invite used to toast "Invitation created." whatever came back, so a
 * provider that did not deliver was reported to the recruiter as a success and
 * the candidate was never told about their interview. The server already says
 * what happened, in a sentence written for the recruiter; the page's only job
 * is to put it where they will read it.
 */

const FALLBACK = 'Invitation created.';

describe('sendOutcome', () => {
  it('shows the server’s own sentence when the email went', () => {
    expect(sendOutcome({ delivered: true, deliveryNote: 'Emailed to ada@example.test.' }, FALLBACK))
      .toEqual({ kind: 'toast', message: 'Emailed to ada@example.test.' });
  });

  it('falls back to the caller’s words when a delivered send says nothing', () => {
    expect(sendOutcome({ delivered: true }, FALLBACK)).toEqual({ kind: 'toast', message: FALLBACK });
  });

  // The whole failure this exists to stop: a green toast over a candidate who
  // was never emailed.
  it('raises the server’s sentence as an error when the email did not go', () => {
    const note = 'No email was sent: EMAIL_PROVIDER is "console", which does not deliver. Copy the link and send it yourself.';

    expect(sendOutcome({ delivered: false, deliveryNote: note }, FALLBACK)).toEqual({ kind: 'error', message: note });
  });

  it('never reports a failed send as a toast', () => {
    expect(sendOutcome({ delivered: false, deliveryNote: 'nope' }, FALLBACK).kind).toBe('error');
  });

  // A reply with no verdict is not a verdict of success. Saying so plainly
  // beats inventing one.
  it('refuses to claim delivery a reply does not confirm', () => {
    const outcome = sendOutcome({}, FALLBACK);

    expect(outcome.kind).toBe('error');
    expect(outcome.message).toContain('could not confirm');
  });

  it('treats a missing reply the same way', () => {
    expect(sendOutcome(undefined, FALLBACK).kind).toBe('error');
  });

  // An undelivered send with no explanation still has to tell the recruiter
  // what to do about it, or the banner is just a red box.
  it('tells the recruiter to send the link themselves when the server gave no reason', () => {
    expect(sendOutcome({ delivered: false }, FALLBACK).message).toContain('Copy the link');
  });
});
