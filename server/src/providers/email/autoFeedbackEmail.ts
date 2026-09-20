import { companyEmail, emailButton, escapeHtml, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';
import { firstName } from '../../engines/openingModel.js';
import type { FeedbackContent } from '../../services/feedbackContentModel.js';

/**
 * The feedback email a candidate receives automatically after their interview.
 *
 * It reads like the invitation did: a note from the company's hiring team,
 * with the company's name at the top, greeting them by first name and signed
 * by the team. It says nothing about how the interview was run — the candidate
 * was told that before they consented — and nothing about any outcome.
 *
 * The plain-text body carries the same words as the HTML, in the same order,
 * because some clients show only the text and the console provider logs it.
 */

/** Where the working link was, in the stored copy of what was sent. */
export const TALK_LINK_PLACEHOLDER = '[link to ask to speak to someone — not stored]';

export interface AutoFeedbackEmailInput {
  readonly to: string;
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly companyName: string;
  readonly content: FeedbackContent;
  /** The single-purpose "speak to a person" link, when one could be issued. */
  readonly talkUrl: string | null;
}

export interface RenderedAutoFeedbackEmail {
  readonly message: EmailMessage;
  /**
   * The plain-text body as it was sent, with the talk link replaced. The link
   * is a live credential and only its hash is stored (candidateLinkToken.ts);
   * a copy of it in this record would undo that.
   */
  readonly storedText: string;
}

const HEADING_STYLE = 'font-size:16px;font-weight:600;margin:22px 0 8px;color:#1a1a22';

function sections(content: FeedbackContent): Array<{ heading: string; points: readonly string[] }> {
  return [
    { heading: 'What came across well', points: content.strengths },
    { heading: 'Areas to develop', points: content.develop },
    { heading: content.suggestions.length > 1 ? 'Some practical suggestions' : 'A practical suggestion', points: content.suggestions },
  ];
}

export function renderAutoFeedbackEmail(input: AutoFeedbackEmailInput): RenderedAutoFeedbackEmail {
  const first = firstName(input.candidateName) || 'there';
  const company = input.companyName.trim();
  const role = input.roleTitle.trim();
  const at = company ? ` at ${company}` : '';
  const team = company ? `The ${company} hiring team` : 'The hiring team';
  const intro = `Thank you for taking the time to interview for the ${role} role${at}. `
    + 'We wanted to share some feedback on your conversation with us, in the hope that it is useful to you.';
  const offer = 'If you would like to talk any of this through with someone on the hiring team, you can ask for that here.';
  const offerNote = 'The link works for the next 30 days and only does this one thing.';
  const closing = 'Thank you again for your time.';

  const textFor = (talkLine: string | null) => [
    `Hi ${first},`,
    '',
    intro,
    ...sections(input.content).flatMap((s) => ['', s.heading, ...s.points.map((p) => `- ${p}`)]),
    ...(talkLine ? ['', offer, talkLine, offerNote] : []),
    '',
    closing,
    '',
    'Best regards,',
    team,
  ].join('\n');

  const html = [
    `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
    `<p style="margin:0 0 6px">${escapeHtml(intro)}</p>`,
    ...sections(input.content).flatMap((s) => [
      `<h2 style="${HEADING_STYLE}">${escapeHtml(s.heading)}</h2>`,
      `<ul style="margin:0 0 8px;padding-left:20px">${s.points.map((p) => `<li style="margin:0 0 8px">${escapeHtml(p)}</li>`).join('')}</ul>`,
    ]),
    ...(input.talkUrl ? [`<p style="margin:18px 0 10px">${escapeHtml(offer)}</p>`, emailButton(input.talkUrl, 'Ask to speak to someone'),
      `<p style="margin:0 0 14px;color:#5a5a6e;font-size:13px">${escapeHtml(offerNote)}</p>`] : []),
    `<p style="margin:18px 0 18px">${escapeHtml(closing)}</p>`,
    `<p style="margin:0">Best regards,<br>${escapeHtml(team)}</p>`,
  ].join('\n');

  const message = companyEmail({
    to: input.to,
    subject: `Thank you for your interview for ${headerSafe(role)}${company ? ` at ${headerSafe(company)}` : ''}`,
    text: textFor(input.talkUrl),
    html,
  }, company || 'Hiring team');

  return { message, storedText: input.talkUrl ? textFor(TALK_LINK_PLACEHOLDER) : message.text };
}
