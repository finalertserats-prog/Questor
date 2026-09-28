import { describe, it, expect } from 'vitest';
import {
  NO_EMAIL_HELP, canSubmitCode, codeFromInput, codeSentMessage, consentIdentityLine, isIdentityCodeRefusal,
  needsIdentityCode, resendLabel, stepAfterConsent, type PortalIdentity,
} from '../src/components/identityCodeModel';

const identity = (over: Partial<PortalIdentity> = {}): PortalIdentity =>
  ({ required: true, channel: 'email', destination: 'p••••@example.com', verified: false, ...over });

describe('when the code step appears', () => {
  it('comes after consent when a code is required and not yet entered', () => {
    expect(stepAfterConsent(identity())).toBe('identity');
  });

  it('is skipped once the code has been entered', () => {
    expect(stepAfterConsent(identity({ verified: true }))).toBe('techcheck');
  });

  it('is skipped when no code applies', () => {
    expect(stepAfterConsent(identity({ required: false }))).toBe('techcheck');
  });

  it('is skipped by an older server that says nothing about identity', () => {
    expect(needsIdentityCode(undefined)).toBe(false);
  });
});

describe('typing the code', () => {
  it('keeps only digits, so a pasted "123 456" works', () => {
    expect(codeFromInput('123 456')).toBe('123456');
  });

  it('stops at six digits', () => {
    expect(codeFromInput('12345678')).toBe('123456');
  });

  it('can be submitted with six digits', () => {
    expect(canSubmitCode('123456', false)).toBe(true);
  });

  it('cannot be submitted short', () => {
    expect(canSubmitCode('12345', false)).toBe(false);
  });

  it('cannot be submitted twice while checking', () => {
    expect(canSubmitCode('123456', true)).toBe(false);
  });
});

describe('what the candidate reads', () => {
  it('is told on the consent screen that a code will follow, and where it goes', () => {
    expect(consentIdentityLine(identity())).toContain('p••••@example.com');
  });

  it('sees no consent line when no code applies', () => {
    expect(consentIdentityLine(identity({ required: false }))).toBeNull();
  });

  it('is told where the code went and how long it lasts', () => {
    expect(codeSentMessage('p••••@example.com')).toBe("We've sent a 6-digit code to p••••@example.com. It works for 10 minutes.");
  });

  it('sees a countdown before the code can be resent', () => {
    expect(resendLabel(42)).toBe('Resend code in 42s');
  });

  it('can resend once the countdown ends', () => {
    expect(resendLabel(0)).toBe('Resend code');
  });

  it('always has a way forward when the email does not arrive', () => {
    expect(NO_EMAIL_HELP[NO_EMAIL_HELP.length - 1]).toMatch(/reply to your invitation email/);
  });

  it('is pointed at spam folders first', () => {
    expect(NO_EMAIL_HELP.some((tip) => /spam/.test(tip))).toBe(true);
  });
});

describe('the room refusing to open', () => {
  it('recognises the refusal that means the code is still owed', () => {
    expect(isIdentityCodeRefusal('identity_code_required')).toBe(true);
  });

  it('leaves other refusals alone', () => {
    expect(isIdentityCodeRefusal('transcript_moved')).toBe(false);
  });
});
