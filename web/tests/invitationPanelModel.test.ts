import { describe, it, expect } from 'vitest';
import { RESENDABLE_STATES, invitationPanel, type InvitationPanelInput } from '../src/components/invitationPanelModel';

/**
 * The invitation card on the interview page. Resend, the recruiter preview and
 * the "check their spam folder" hint only make sense before the candidate has
 * started; the server refuses a resend after that (routes/interviews.ts).
 */

const DATE = (iso: string) => iso.slice(0, 10);

function input(over: Partial<InvitationPanelInput> = {}): InvitationPanelInput {
  return {
    state: 'INVITED', startedAt: null, completedAt: null,
    sentAt: '2026-09-18T09:00:00.000Z', openedAt: null, assessmentId: null, ...over,
  };
}

describe('before the candidate has started', () => {
  it.each([...RESENDABLE_STATES])('offers resend and the preview while %s', (state) => {
    expect(invitationPanel(input({ state }), DATE)).toMatchObject({ kind: 'not-started', canResend: true });
  });

  it('suggests the spam folder when the email went but the link was not opened', () => {
    expect(invitationPanel(input(), DATE)).toMatchObject({ showNotOpenedHint: true });
  });

  it('drops the spam hint once the candidate opened the link', () => {
    expect(invitationPanel(input({ openedAt: '2026-09-18T10:00:00.000Z' }), DATE)).toMatchObject({ showNotOpenedHint: false });
  });
});

describe('once the candidate has started', () => {
  it('says when they started a live interview', () => {
    expect(invitationPanel(input({ state: 'ASSESSING', startedAt: '2026-09-19T08:00:00.000Z' }), DATE))
      .toEqual({ kind: 'status', text: 'The candidate started this interview on 2026-09-19.', assessmentId: null });
  });

  it('still says they started when the start time is unknown', () => {
    expect(invitationPanel(input({ state: 'WARMUP' }), DATE))
      .toEqual({ kind: 'status', text: 'The candidate has started this interview.', assessmentId: null });
  });

  it.each(['REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED'])('says when a %s interview was completed', (state) => {
    expect(invitationPanel(input({ state, completedAt: '2026-09-19T09:00:00.000Z', assessmentId: 'a1' }), DATE))
      .toEqual({ kind: 'status', text: 'Interview completed on 2026-09-19.', assessmentId: 'a1' });
  });

  it('says the assessment is being prepared while it is processed', () => {
    expect(invitationPanel(input({ state: 'PROCESSING' }), DATE))
      .toEqual({ kind: 'status', text: 'The candidate finished this interview. The assessment is being prepared.', assessmentId: null });
  });

  it.each([
    ['CANDIDATE_WITHDREW', 'The candidate withdrew from this interview, so there is no invitation to resend.'],
    ['INCOMPLETE', 'This interview stopped part-way, so there is no invitation to resend.'],
    ['CANCELLED', 'This interview was cancelled, so there is no invitation to resend.'],
  ])('explains a %s interview instead of offering a resend', (state, text) => {
    expect(invitationPanel(input({ state }), DATE)).toEqual({ kind: 'status', text, assessmentId: null });
  });

  it('never offers a resend for a completed interview', () => {
    expect(invitationPanel(input({ state: 'REVIEW_READY', completedAt: '2026-09-19T09:00:00.000Z' }), DATE).kind).toBe('status');
  });
});
