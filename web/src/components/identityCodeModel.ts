/**
 * The one-time code a candidate enters after consent and before the interview
 * room opens (identity assurance L1; server services/identityCode.ts). Kept
 * free of React so the wording and the rules can be unit tested
 * (web/tests/identityCodeModel.test.ts).
 *
 * The copy is written for someone about to be interviewed: it says why the
 * code is asked for before it asks, never implies suspicion, and always offers
 * a way forward when the email does not arrive.
 */

/** GET /api/portal/:token `identity`; absent on an older server. */
export interface PortalIdentity {
  readonly required: boolean;
  readonly channel: 'email';
  /** Masked, e.g. p••••@example.com. */
  readonly destination: string;
  readonly verified: boolean;
}

export const CODE_LENGTH = 6;
/** The server's resend cooldown; used when a refusal does not say how long. */
export const RESEND_COOLDOWN_SECONDS = 60;
export const CODE_VALID_MINUTES = 10;

/** Whether the candidate still has a code to enter before the room. */
export function needsIdentityCode(identity: PortalIdentity | null | undefined): boolean {
  return identity?.required === true && identity.verified !== true;
}

/** Where the journey goes after consent is recorded. */
export function stepAfterConsent(identity: PortalIdentity | null | undefined): 'identity' | 'techcheck' {
  return needsIdentityCode(identity) ? 'identity' : 'techcheck';
}

/** Digits only, at most six: a pasted "123 456" or "123-456" still works. */
export function codeFromInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

export function canSubmitCode(code: string, busy: boolean): boolean {
  return !busy && code.length === CODE_LENGTH;
}

export function resendLabel(secondsLeft: number): string {
  return secondsLeft > 0 ? `Resend code in ${secondsLeft}s` : 'Resend code';
}

/** The line on the consent screen, so nobody meets the code step unannounced. */
export function consentIdentityLine(identity: PortalIdentity | null | undefined): string | null {
  if (!identity?.required) return null;
  return `After you agree, we will email a ${CODE_LENGTH}-digit code to ${identity.destination} to confirm it is you. We ask every candidate for this.`;
}

export const IDENTITY_HEADING = 'Confirm it\'s you';

export const IDENTITY_WHY = 'This quick check confirms that the person taking the interview is the person who applied. We do it for every candidate, and it only takes a moment.';

export function codeSentMessage(destination: string): string {
  return `We've sent a ${CODE_LENGTH}-digit code to ${destination}. It works for ${CODE_VALID_MINUTES} minutes.`;
}

export const SENDING_MESSAGE = 'Sending your code…';

/** What to try when the email has not arrived, in the order worth trying. */
export const NO_EMAIL_HELP: readonly string[] = [
  'It can take a minute or two to arrive.',
  'Check your spam or junk folder, and any "Other" or "Promotions" tab.',
  'Still nothing? Ask for a new code once the timer runs out.',
  'If it still does not arrive, reply to your invitation email and the hiring team will help you continue.',
];

/**
 * The server's refusal to open the room because the code has not been entered
 * (a consent given in another tab, a bookmark straight to the room). The room
 * sends the candidate back to their invitation page, which asks for it.
 */
export function isIdentityCodeRefusal(code: string | undefined): boolean {
  return code === 'identity_code_required';
}
