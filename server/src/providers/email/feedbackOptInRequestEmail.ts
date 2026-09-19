import { brandedEmail, emailButton, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';

/**
 * "Would you like written feedback on your interview?", sent when the hiring
 * team asks a candidate who was never asked at the end of their interview.
 *
 * The wording has one job: make it easy to say no. A candidate who ignores
 * this is not sent anything, and the email says so, so silence is never read
 * as a yes by the person receiving it either.
 */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function renderFeedbackOptInRequestEmail(opts: {
  to: string;
  roleTitle: string;
  consentUrl: string;
  ttlDays: number;
}): EmailMessage {
  const role = headerSafe(opts.roleTitle);
  const text = [
    `Thank you for interviewing with us for the ${role} role.`,
    '',
    'Would you like written feedback on your interview by email? It would be a short note from the hiring team '
    + 'about what went well and what you could work on. It does not change any decision about your application.',
    '',
    'Choose yes or no here:',
    '',
    opts.consentUrl,
    '',
    'If you do not answer, we will not send you any feedback. You can ignore this email.',
    `The link works for ${opts.ttlDays} days and only records this one answer.`,
  ].join('\n');

  const html = `<p style="margin:0 0 12px">Thank you for interviewing with us for the ${escapeHtml(role)} role.</p>
<p style="margin:0 0 12px">Would you like written feedback on your interview by email? It would be a short note
from the hiring team about what went well and what you could work on. It does not change any decision about your
application.</p>
${emailButton(opts.consentUrl, 'Choose yes or no')}
<p style="margin:0 0 10px">If you do not answer, we will not send you any feedback. You can ignore this email.</p>
<p style="margin:0;color:#5a5a6e;font-size:12px">The link works for ${opts.ttlDays} days and only records this one answer.</p>`;

  return brandedEmail({
    to: opts.to,
    subject: `Would you like feedback on your interview? — ${role}`,
    text: `${text}\n`,
    html,
  });
}
