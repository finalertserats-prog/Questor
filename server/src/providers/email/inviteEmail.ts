import { brandedEmail, emailButton, escapeHtml, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';

// The mail that adds a colleague to an organisation.
//
// It carries a link and no password, because nobody but the recipient is ever
// going to know theirs — that is the whole reason this mail exists rather than
// an admin typing one in (docs/credentials-contract.md §4). The link is the
// only secret in the message, and it is in the URL fragment, so it survives
// neither an access log nor a Referer header.

function p(text: string): string {
  return `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`;
}

function quiet(text: string): string {
  return `<p style="margin:0 0 12px;color:#5a5a6e;font-size:14px">${escapeHtml(text)}</p>`;
}

export function renderUserInviteEmail(opts: {
  to: string;
  name: string;
  /** The colleague who sent it, named so an unexpected mail has someone to ask about. */
  invitedBy: string;
  organisation: string;
  url: string;
  validDays: number;
}): EmailMessage {
  const greeting = `Hi ${opts.name.split(' ')[0] || 'there'},`;
  const org = opts.organisation.trim();
  const intro = org
    ? `${opts.invitedBy} has invited you to join ${org} on Questor.`
    : `${opts.invitedBy} has invited you to join them on Questor.`;
  const action = 'Follow the link below to choose a password and sign in. Nobody else sets it, and nobody else sees it.';
  const validity = `The link works once and stops working in ${opts.validDays} days.`;
  const ignore = 'If you were not expecting this, you can ignore this email. No account exists until the link is used.';

  const text = [
    greeting, '', intro, '', action, '', 'Set your password:', opts.url, '', validity, '', ignore, '',
    'Questor',
  ].join('\n');

  return brandedEmail({
    to: opts.to,
    // `headerSafe` on the organisation: it is typed by a customer and this is a
    // header, where a newline would let the rest of the value be read as one of
    // ours. No address in the subject — a header is retained and logged far
    // more widely than a body, and the message is already addressed to them.
    subject: org ? `You have been invited to ${headerSafe(org)} on Questor` : 'You have been invited to Questor',
    text,
    html: [
      p(greeting),
      p(intro),
      p(action),
      emailButton(opts.url, 'Set your password'),
      quiet(validity),
      quiet(ignore),
    ].join('\n'),
  });
}
