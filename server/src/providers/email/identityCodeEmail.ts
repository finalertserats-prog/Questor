import { companyEmail, escapeHtml, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';

/**
 * The one-time code a candidate enters before the interview room opens
 * (services/identityCode.ts). It comes from the hiring company, like the
 * invitation, and says why it is asked for: an unexplained code arriving
 * before an interview reads as a phishing attempt, or as suspicion.
 *
 * Deliberately carries no link. The candidate already has the page open, and a
 * code mailed next to the portal link would make a forwarded email enough to
 * pass the check it exists for.
 */
export function renderIdentityCodeEmail(opts: {
  to: string;
  firstName: string;
  roleTitle: string;
  companyName: string;
  code: string;
  validMinutes: number;
}): EmailMessage {
  const greeting = `Hi ${opts.firstName || 'there'},`;
  const intro = `Here is your code for the ${opts.roleTitle} interview at ${opts.companyName}:`;
  const use = `Enter it on the interview page to continue. It works once and expires in ${opts.validMinutes} minutes.`;
  const why = 'We ask for a code to confirm it\'s you, the person who applied, taking the interview. We do this for every candidate.';
  const ignore = 'If you did not ask for this code, you can ignore this email.';
  const text = [
    greeting, '', intro, '', opts.code, '', use, '', why, '', ignore, '',
    'Best regards,', `The ${opts.companyName} hiring team`,
  ].join('\n');
  const html = [
    `<p style="margin:0 0 14px">${escapeHtml(greeting)}</p>`,
    `<p style="margin:0 0 10px">${escapeHtml(intro)}</p>`,
    `<p style="margin:0 0 16px;font-size:28px;font-weight:600;letter-spacing:6px;font-family:Consolas,Menlo,monospace">${escapeHtml(opts.code)}</p>`,
    `<p style="margin:0 0 14px">${escapeHtml(use)}</p>`,
    `<p style="margin:0 0 14px;color:#5a5a6e;font-size:14px">${escapeHtml(why)}</p>`,
    `<p style="margin:0 0 18px;color:#5a5a6e;font-size:14px">${escapeHtml(ignore)}</p>`,
    `<p style="margin:0">Best regards,<br>The ${escapeHtml(opts.companyName)} hiring team</p>`,
  ].join('\n');
  return companyEmail({
    to: opts.to,
    subject: `Your code for the ${headerSafe(opts.roleTitle)} interview`,
    text,
    html,
  }, opts.companyName);
}
