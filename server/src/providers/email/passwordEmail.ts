import { brandedEmail, emailButton, escapeHtml, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';

// The two mails the password routes send.
//
// Neither carries a password. The reset mail carries a link and nothing else
// that is worth stealing; the notification carries no secret at all, which is
// what lets it be sent to an address that may already be in someone else's
// hands without making things worse.

function p(text: string): string {
  return `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`;
}

function quiet(text: string): string {
  return `<p style="margin:0 0 12px;color:#5a5a6e;font-size:14px">${escapeHtml(text)}</p>`;
}

/**
 * The link that lets someone set a new password.
 *
 * The token lives in the URL's fragment (services/passwordReset.ts explains
 * why), so mail clients that rewrite links for click tracking keep it — a
 * fragment survives a redirect — while no server between here and the browser
 * writes it into a log.
 */
export function renderPasswordResetEmail(opts: {
  to: string;
  name: string;
  url: string;
  validMinutes: number;
  /** True when an administrator sent it rather than the account holder asking. */
  sentByAdmin: boolean;
}): EmailMessage {
  const greeting = `Hi ${opts.name.split(' ')[0] || 'there'},`;
  const intro = opts.sentByAdmin
    ? 'An administrator at your organisation has sent you a link to set a new Questor password.'
    : 'Someone asked to reset the password for your Questor account.';
  const validity = `The link works once and stops working in ${Math.round(opts.validMinutes)} minutes.`;
  // Said plainly, because the honest answer to "I did not ask for this" is
  // usually "then nothing has happened" — and a person who is told that does
  // not go hunting for a way to cancel something that was never started.
  const ignore = opts.sentByAdmin
    ? 'If you were not expecting this, speak to your administrator before using the link.'
    : 'If that was not you, you can ignore this email. Your password has not changed, and nothing happens until the link is used.';
  const sessions = 'Setting a new password signs the account out everywhere else.';

  const text = [
    greeting, '', intro, '', 'Set a new password:', opts.url, '', validity, '', ignore, '', sessions, '',
    'Questor',
  ].join('\n');

  return brandedEmail({
    to: opts.to,
    subject: `Set a new Questor password for ${headerSafe(opts.to)}`,
    text,
    html: [
      p(greeting),
      p(intro),
      emailButton(opts.url, 'Set a new password'),
      quiet(validity),
      quiet(ignore),
      quiet(sessions),
    ].join('\n'),
  });
}

/**
 * Sent after the password actually moved, to the address on the account.
 *
 * This is the mail that makes a stolen account surface: whoever still reads
 * that inbox learns within seconds that someone changed the way in, which is
 * the only warning an app with no other channel to its user can give.
 */
export function renderPasswordChangedEmail(opts: {
  to: string;
  name: string;
  how: 'reset' | 'change';
  at: Date;
  signInUrl: string;
}): EmailMessage {
  const greeting = `Hi ${opts.name.split(' ')[0] || 'there'},`;
  const what = opts.how === 'reset'
    ? 'Your Questor password was just set using a reset link.'
    : 'Your Questor password was just changed from your settings.';
  // UTC, spelled out. A local time would be the server's idea of local, which
  // is not the reader's, and a reader deciding whether this was them needs to
  // be able to place it against their own morning.
  const when = `This happened at ${opts.at.toISOString().replace('T', ' ').slice(0, 16)} UTC.`;
  const ok = 'If this was you, there is nothing to do.';
  const notOk = 'If it was not you, someone else may have reached your account. Reset your password again straight away and tell your administrator.';
  const sessions = 'Every other signed-in browser has been signed out.';

  const text = [greeting, '', what, when, '', ok, '', notOk, '', sessions, '', opts.signInUrl, '', 'Questor'].join('\n');

  return brandedEmail({
    to: opts.to,
    subject: 'Your Questor password was changed',
    text,
    html: [
      p(greeting),
      p(what),
      quiet(when),
      p(ok),
      p(notOk),
      quiet(sessions),
      emailButton(opts.signInUrl, 'Sign in'),
    ].join('\n'),
  });
}
