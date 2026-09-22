/**
 * Text messages to candidates: the second channel for the one-time identity
 * code (services/identityCode.ts), used where the application has a phone
 * number.
 *
 * No provider is implemented yet. SMS needs an account with a vendor (the
 * identity plan recommends Twilio Verify), which has not been set up, so
 * getSms() answers null and codes go by email only. Adding a vendor means
 * implementing SmsProvider, returning it from getSms() when its settings are
 * present, and the code service will offer the channel.
 */

export interface SmsMessage {
  /** E.164, e.g. +919812345678. */
  readonly to: string;
  /** Plain text; kept short enough for one segment. */
  readonly body: string;
}

export interface SmsProvider {
  readonly name: string;
  /** Whether a message actually reaches the phone (false for a logging stand-in). */
  readonly delivers: boolean;
  send(message: SmsMessage, opts?: { readonly signal?: AbortSignal }): Promise<{ status: string; id: string }>;
}

/** The configured SMS provider, or null when none is set up (today, always). */
export function getSms(): SmsProvider | null {
  return null;
}
