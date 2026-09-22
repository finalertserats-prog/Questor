import { brandedEmail, companyEmail, emailButton, escapeHtml, headerSafe } from './branding.js';
import { firstName } from '../../engines/openingModel.js';
import type { EmailMessage } from './index.js';

/**
 * HR-Box reminder emails (services/invitationReminders.ts).
 *
 * The candidate's reads like the invitation it follows: a short note from the
 * company's hiring team, warm and without pressure, the same link written out
 * under the button. It never says the candidate is late, and the second one
 * says plainly that it is the last.
 */

export type CandidateReminderStage = 'day3' | 'day10';

export interface CandidateReminderDetails {
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly companyName: string;
  readonly portalUrl: string;
  readonly durationMinutes: number;
  readonly expiresAt: Date;
  /** The zone the date is written in: the booking's, else the organisation's. */
  readonly timeZone: string;
  readonly stage: CandidateReminderStage;
}

function closingDate(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(at);
  return `${day} (${timeZone})`;
}

export function buildCandidateReminder(d: CandidateReminderDetails): EmailMessage {
  const first = firstName(d.candidateName) || 'there';
  const until = closingDate(d.expiresAt, d.timeZone);
  const lines = d.stage === 'day3'
    ? [
      `Just a friendly note in case our earlier email got buried: your first-round interview for the ${d.roleTitle} role at ${d.companyName} is ready whenever you are.`,
      `It takes about ${d.durationMinutes} minutes, and you can do it at a time that suits you, from a laptop or a phone.`,
    ]
    : [
      `Your interview link for the ${d.roleTitle} role at ${d.companyName} is open until ${until}. This is the last reminder we will send.`,
      `It takes about ${d.durationMinutes} minutes. If you need any adjustments, you can ask for them when you open the link.`,
    ];
  const closing = d.stage === 'day3' ? `The link is open until ${until}.` : 'We hope to hear from you.';
  const text = [
    `Hi ${first},`, '', ...lines.flatMap((line) => [line, '']),
    `Start your interview: ${d.portalUrl}`, '', closing, '', 'Best regards,', `The ${d.companyName} hiring team`,
  ].join('\n');
  const html = [
    `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
    ...lines.map((line) => `<p style="margin:0 0 14px">${escapeHtml(line)}</p>`),
    emailButton(d.portalUrl, 'Start your interview'),
    `<p style="margin:0 0 18px;color:#5a5a6e;font-size:14px">${escapeHtml(closing)}</p>`,
    `<p style="margin:0">Best regards,<br>The ${escapeHtml(d.companyName)} hiring team</p>`,
  ].join('\n');
  const subject = d.stage === 'day3'
    ? `A reminder: your interview for ${headerSafe(d.roleTitle)} at ${headerSafe(d.companyName)}`
    : `Your interview link for ${headerSafe(d.roleTitle)} closes soon`;
  return companyEmail({ to: '', subject, text, html }, d.companyName);
}

export interface RecruiterExpiryDetails {
  readonly recruiterName: string;
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly expiresAt: Date;
  readonly timeZone: string;
  /** The interview's page in the console, where the invitation can be resent. */
  readonly interviewUrl: string;
  readonly opened: boolean;
}

export function buildRecruiterExpiryWarning(d: RecruiterExpiryDetails): EmailMessage {
  const first = firstName(d.recruiterName) || 'there';
  const until = closingDate(d.expiresAt, d.timeZone);
  const seen = d.opened ? 'They have opened the link but not started.' : 'They have not opened the link yet.';
  const body = `${d.candidateName}'s interview invitation for ${d.roleTitle} closes on ${until}. ${seen} You can resend it, or get in touch with them, from the interview's page.`;
  const text = [`Hi ${first},`, '', body, '', `Open the interview: ${d.interviewUrl}`, '', 'This is sent once per invitation to the recruiters who own the candidate.'].join('\n');
  const html = [
    `<p>Hi ${escapeHtml(first)},</p>`,
    `<p>${escapeHtml(body)}</p>`,
    emailButton(d.interviewUrl, 'Open the interview'),
    '<p style="color:#5a5a6e;font-size:13px">This is sent once per invitation to the recruiters who own the candidate.</p>',
  ].join('\n');
  return brandedEmail({ to: '', subject: `Invitation closing soon: ${headerSafe(d.candidateName)}, ${headerSafe(d.roleTitle)}`, text, html });
}
