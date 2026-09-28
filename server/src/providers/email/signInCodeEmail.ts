import { brandedEmail, escapeHtml } from './branding.js';
import type { EmailMessage } from './index.js';

/**
 * The six digits someone enters after their password.
 *
 * Carries no link, deliberately. A code next to a button is a code that can be
 * phished with one message; a code that can only be typed into a page the
 * person already has open is one an attacker has to talk them through, out
 * loud, which is a far higher bar.
 *
 * It says where the attempt came from, because the only person who can tell
 * whether a sign-in is theirs is the person reading this.
 */
export function renderSignInCodeEmail(opts: {
  to: string;
  name: string;
  code: string;
  validMinutes: number;
  ip: string;
}): EmailMessage {
  const greeting = `Hi ${opts.name.split(' ')[0] || 'there'},`;
  const intro = 'Here is your Questor sign-in code:';
  const use = `Type it on the sign-in page. It works once and expires in ${Math.round(opts.validMinutes)} minutes.`;
  const from = opts.ip && opts.ip !== 'unknown' ? `The attempt came from ${opts.ip}.` : '';
  const ignore = 'If you did not just try to sign in, someone else has your password. Do not enter this code — reset your password instead, and tell your administrator.';

  const text = [greeting, '', intro, '', opts.code, '', use, from, '', ignore, '', 'Questor'].filter((line) => line !== undefined).join('\n');

  return brandedEmail({
    to: opts.to,
    // The code is deliberately NOT in the subject. A subject line is retained
    // and logged far more widely than a body — SMTP relays, anti-spam
    // gateways, mailbox search indexes, and the lock screen of a phone sitting
    // face-up on a desk. Several large providers do put it there; the
    // convenience is not worth a second factor readable without unlocking
    // anything.
    subject: 'Your Questor sign-in code',
    text,
    html: [
      `<p style="margin:0 0 14px">${escapeHtml(greeting)}</p>`,
      `<p style="margin:0 0 10px">${escapeHtml(intro)}</p>`,
      `<p style="margin:0 0 16px;font-size:28px;font-weight:600;letter-spacing:6px;font-family:Consolas,Menlo,monospace">${escapeHtml(opts.code)}</p>`,
      `<p style="margin:0 0 14px">${escapeHtml(use)}</p>`,
      from ? `<p style="margin:0 0 14px;color:#5a5a6e;font-size:14px">${escapeHtml(from)}</p>` : '',
      `<p style="margin:0 0 14px;color:#5a5a6e;font-size:14px">${escapeHtml(ignore)}</p>`,
      '<p style="margin:0">Questor</p>',
    ].filter(Boolean).join('\n'),
  });
}
