import { brandedEmail } from './branding.js';
import type { EmailMessage } from './index.js';

/**
 * The feedback email itself.
 *
 * This is read by someone who may have just been turned down, on a phone, in
 * their own time. Two consequences shape everything here:
 *
 *   - The plain-text body is not an afterthought. `brandedEmail()` decorates
 *     only the HTML, and the text body is what a stripped-down client shows and
 *     what the console provider logs. It carries the same words and the same
 *     link, in full.
 *   - The body is written by a person. `approvedText` is free text a reviewer
 *     typed, so it is escaped BEFORE any structure is applied to it — a
 *     reviewer pasting something from a candidate's transcript must not be able
 *     to put markup into another person's mailbox.
 */

const HEADING = /^##\s+(.*)$/;
const BULLET = /^-\s+(.*)$/;
const QUOTED = /^\s{2,}You said: (.*)$/;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Turn the approved plain-text body into HTML.
 *
 * Escaping happens first, on the whole string, so the structural matching below
 * can only ever see inert text. `##` and `-` survive escaping, which is why the
 * draft format uses them.
 */
function renderBody(approvedText: string): string {
  const out: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
  };

  for (const raw of escapeHtml(approvedText).split(/\r?\n/)) {
    const line = raw.trimEnd();

    if (!line.trim()) { closeList(); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      closeList();
      out.push(`<h2 style="font-size:17px;font-weight:600;margin:26px 0 8px;color:#1a1a22">${heading[1]}</h2>`);
      continue;
    }

    // A quoted answer is the evidence for the point above it, so it is set apart
    // rather than folded into the bullet — the candidate should be able to see
    // at a glance which words of theirs each point rests on.
    const quoted = QUOTED.exec(line);
    if (quoted) {
      closeList();
      out.push(
        '<blockquote style="margin:6px 0 14px;padding:8px 14px;border-left:3px solid #c9c9d8;'
        + `color:#42424f;font-style:italic">${quoted[1]}</blockquote>`,
      );
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      if (!inList) { out.push('<ul style="margin:8px 0 14px;padding-left:20px">'); inList = true; }
      out.push(`<li style="margin:0 0 6px">${bullet[1]}</li>`);
      continue;
    }

    closeList();
    out.push(`<p style="margin:0 0 12px">${line}</p>`);
  }

  closeList();
  return out.join('\n');
}

/**
 * Build the message. `talkUrl` is omitted when no link could be issued, and the
 * offer is then left out entirely rather than rendered as a dead button.
 */
export function renderCandidateFeedbackEmail(opts: {
  to: string;
  roleTitle: string;
  approvedText: string;
  talkUrl: string | null;
}): EmailMessage {
  const offerText = opts.talkUrl
    ? [
      '',
      '---',
      '',
      'Would you like to speak to a person?',
      '',
      'If you would rather talk this through with someone on the hiring team than read it, you can ask for '
      + 'that here. It is one click, and nobody will call you unless you do.',
      '',
      opts.talkUrl,
      '',
      'That link works for the next 30 days and only does this one thing.',
    ].join('\n')
    : '';

  const offerHtml = opts.talkUrl
    ? `<hr style="border:0;border-top:1px solid #d8d8e2;margin:26px 0 18px">
<h2 style="font-size:17px;font-weight:600;margin:0 0 8px;color:#1a1a22">Would you like to speak to a person?</h2>
<p style="margin:0 0 14px">If you would rather talk this through with someone on the hiring team than read it,
you can ask for that here. It is one click, and nobody will call you unless you do.</p>
<p style="margin:0 0 10px">
  <a href="${escapeHtml(opts.talkUrl)}"
     style="display:inline-block;background:#2f2f7a;color:#ffffff;text-decoration:none;
            padding:11px 20px;border-radius:6px;font-weight:600">Yes, I'd like to speak to someone</a>
</p>
<p style="margin:0;color:#5a5a6e;font-size:12px">That link works for the next 30 days and only does this one thing.</p>`
    : '';

  return brandedEmail({
    to: opts.to,
    subject: `Your interview feedback — ${opts.roleTitle}`,
    text: `${opts.approvedText}${offerText}\n`,
    html: `${renderBody(opts.approvedText)}\n${offerHtml}`,
  });
}
