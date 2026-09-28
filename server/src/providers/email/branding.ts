import { config } from '../../config.js';
import type { EmailMessage } from './index.js';

/**
 * Wrap a message in Questor's brand.
 *
 * Only the HTML body is decorated. The plain-text body is passed through
 * untouched: a candidate whose mail client strips HTML still needs the link and
 * the plain words, and that is also the body the console provider logs when a
 * deployment has no real mail configured.
 *
 * The mark is served from this deployment rather than embedded, so it follows
 * whatever logo the product is running; a client that blocks remote images
 * falls back to the alt text, which is why the alt text is the product name.
 */
/**
 * Mail is read on white, so it always takes the light cut of the wordmark —
 * a mail client does not know the reader's Questor theme. The file is 96 px
 * tall and drawn at 32: three source pixels to every CSS pixel keeps it sharp
 * on high-density screens. Only the height is fixed; the width follows the
 * artwork, so a redrawn wordmark of a different length is never squashed.
 */
const WORDMARK_FILE = 'questor-wordmark-light.png';
const WORDMARK_HEIGHT_PX = 32;

export function brandedEmail(message: EmailMessage): EmailMessage {
  const wordmark = `${config.webOrigin.replace(/\/+$/, '')}/brand/${WORDMARK_FILE}`;
  const html = `<div style="font-family:Segoe UI,system-ui,-apple-system,sans-serif;color:#1a1a22;font-size:15px;line-height:1.55;max-width:560px">
<img src="${wordmark}" alt="Questor" height="${WORDMARK_HEIGHT_PX}" style="height:${WORDMARK_HEIGHT_PX}px;width:auto;max-width:60%;border:0;display:block;margin:0 0 18px">
${message.html}
<hr style="border:0;border-top:1px solid #d8d8e2;margin:22px 0 10px">
<p style="color:#5a5a6e;font-size:12px;margin:0">Questor — The intelligence behind every hire.</p>
</div>`;

  return { ...message, html };
}

/**
 * What every surface in a Questor email states about itself.
 *
 * Three rules, each closing a failure a real mail client produces.
 *
 * COLOURS ARE DECLARED TWICE. Outlook's Word renderer ignores CSS `background`
 * on a table or a cell and reads only the `bgcolor` attribute, so a background
 * that exists only in the style attribute arrives white. Every coloured
 * surface therefore carries both.
 *
 * NOTHING INHERITS. A client that forces dark mode repaints whatever has no
 * colour of its own, and a paragraph that relied on the default black became
 * black on black. Every block states its own colour and its own background.
 * `color-scheme` tells the clients that honour it (Apple Mail, Outlook.com)
 * that this message handles both schemes, which buys a gentler inversion
 * rather than a forced one — it reduces the damage, it does not remove it,
 * which is why the explicit colours above still matter.
 *
 * NOTHING RELIES ON AN IMAGE. A candidate reading with images blocked sees
 * every word, because there is nothing in these emails but words.
 */
const FONT = 'Segoe UI,system-ui,-apple-system,Helvetica,Arial,sans-serif';
const INK = '#1a1a22';
const QUIET_INK = '#5a5a6e';
const RULE = '#e3e3ea';
const ACCENT = '#2f2f7a';
const PAGE = '#f4f4f7';
const NOTICE_BG = '#f7f7fb';
/** Long values wrap inside their cell instead of widening the message around them. */
const WRAP = 'word-break:break-word;overflow-wrap:break-word';

/**
 * The line a mail client shows in the inbox beside the subject, before anyone
 * opens anything.
 *
 * Without one the client takes the first words of the body, so every
 * invitation previewed as "Hi Ada,". Hidden three ways because no single way
 * works everywhere: `display:none` for most clients, zero height and hidden
 * overflow for the ones that ignore it, and `mso-hide:all` for Outlook, which
 * ignores `display:none` outright.
 */
export function preheader(line: string): string {
  const text = line.trim();
  if (!text) return '';
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE}">${escapeHtml(text)}</div>`;
}

/**
 * Mail a candidate receives from the company that is hiring. It reads as a note
 * from that company's hiring team, so it carries the company's name at the top
 * instead of the product's mark and no product tagline. Laid out as a table
 * with inline styles because that is what mail clients reliably render.
 *
 * An organisation's name is typed by a customer and can be long, so the header
 * wraps it rather than pushing the card wider than the reader's screen.
 */
export function companyEmail(message: EmailMessage, companyName: string, previewLine = ''): EmailMessage {
  const company = escapeHtml(companyName);
  const html = `<div style="background:${PAGE};padding:24px 12px;font-family:${FONT};color-scheme:light dark;supported-color-schemes:light dark">
${preheader(previewLine)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${RULE};border-radius:10px;border-collapse:separate;table-layout:fixed">
<tr><td style="padding:22px 28px 6px;font-size:18px;font-weight:600;color:${INK};border-bottom:1px solid #eeeef3;${WRAP}">${company}</td></tr>
<tr><td style="padding:18px 28px 26px;font-size:15px;line-height:1.6;color:${INK}">${message.html}</td></tr>
</table>
<p style="max-width:560px;margin:12px auto 0;font-size:12px;color:#8a8a9a;text-align:center;${WRAP}">Sent on behalf of ${company}.</p>
</div>`;
  return { ...message, html };
}

/**
 * A button that still works when links do not. Gmail disables every link in a
 * message it files as spam, and some company mail systems strip them; an
 * address that lived only inside the button left a candidate with the words
 * "Start or schedule your interview" and nothing to click or copy. So the
 * address is always written out underneath as plain text.
 *
 * The colour and the padding are on the table cell, not on the anchor. Word —
 * which is what Outlook on Windows renders with — drops padding and background
 * from an inline-block anchor, so the previous button arrived there as bare
 * underlined text with no button around it at all. A padded cell with a
 * `bgcolor` attribute is the one construction every client draws, and it needs
 * no VML fallback, which breaks again under Windows display scaling.
 */
/**
 * An address that is safe to make clickable in an email.
 *
 * Escaping keeps a value inside the attribute it was put in; it says nothing
 * about where the attribute points. A meeting URL is typed by an operator and
 * reaches this untouched, and `data:` in an href renders a page of the
 * author's choosing under no domain at all — a credible way to phish somebody
 * who is expecting a link from their own company. `javascript:` does not run
 * in a mail client, but it does in the browser a reader pastes into.
 *
 * Only http and https, and only an absolute URL. Anything else comes back
 * empty, and every caller draws the address as plain text instead of as
 * something to click: the reader still sees exactly what was configured, and
 * can judge it, which is the outcome an operator's mistake should have.
 *
 * Parsing alone is not the test. `new URL` accepts several forms that read as
 * one host and resolve to another — `https://trusted.example@evil.example/`
 * puts a trusted name in front of the @ and goes to what follows it, and a
 * backslash is normalised to a slash, so `https:/\evil.example` is a link to
 * evil.example that does not look like one. In an email, where the whole
 * defence a reader has is reading the address, a link that lies about where
 * it goes is the attack. So: the raw value must already be written as
 * `http://` or `https://`, must carry no credentials and no control character
 * or backslash, and what comes back is the PARSED form — what the browser
 * will actually do — rather than the string somebody typed.
 */
const PLAIN_HTTP_URL = /^https?:\/\//i;
// Written as a code-point test rather than a character class, so no control
// character has to survive a source literal.
function hasControlOrBackslash(value: string): boolean {
  const SPACE = 32;
  const DEL = 127;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < SPACE || code === DEL || ch === '\\') return true;
  }
  return false;
}

export function safeHref(href: string): string {
  const value = href.trim();
  if (!PLAIN_HTTP_URL.test(value) || hasControlOrBackslash(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    // A name in front of the @ is not the host, and in an email it is there
    // to be mistaken for one.
    if (url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function emailButton(href: string, label: string): string {
  const safe = safeHref(href);
  // Nothing to click, but the address is still shown: a reader who was sent a
  // link the product will not make clickable should be able to see why.
  if (!safe) {
    return `<p style="margin:0 0 16px;color:${QUIET_INK};font-size:13px;line-height:1.5">${escapeHtml(label)} — copy this link into your browser:<br><span style="color:${INK};word-break:break-all">${escapeHtml(href.trim())}</span></p>`;
  }
  // The parsed form in both places, so what the reader copies out of the
  // message is exactly where the button goes.
  const url = escapeHtml(safe);
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 0 12px;border-collapse:separate"><tr>
<td align="center" bgcolor="${ACCENT}" style="background-color:${ACCENT};border-radius:6px;padding:13px 26px"><a href="${url}" style="display:inline-block;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:15px;font-weight:600;line-height:1.2">${escapeHtml(label)}</a></td>
</tr></table>
<p style="margin:0 0 16px;color:${QUIET_INK};font-size:13px;line-height:1.5">If the button does not work, copy this link into your browser:<br><span style="color:${INK};word-break:break-all">${url}</span></p>`;
}

/** One line of the details block: what it is, and what it says. */
export interface DetailRow {
  readonly label: string;
  readonly value: string;
}

/**
 * The block that makes an email read as a real appointment rather than a note:
 * what the interview is for, who is conducting it, when, and how long.
 *
 * A two-column table with a fixed layout, because the alternative — a
 * paragraph — is what a 90-character role title turns into a wall. Fixed
 * layout plus wrapping in the value cell is what stops one long value from
 * widening the whole message and forcing the reader to scroll sideways on a
 * phone. Both halves of every row are escaped: a role title comes out of a job
 * description, which is text somebody typed.
 *
 * A row with no value is dropped rather than drawn empty — "Interviewer:" with
 * nothing after it looks like the email failed to fill itself in.
 */
export function detailsTable(rows: readonly DetailRow[]): string {
  const filled = rows.filter((row) => row.value.trim().length > 0);
  if (filled.length === 0) return '';
  const cells = filled.map((row, i) => {
    const edge = i === filled.length - 1 ? '' : `border-bottom:1px solid ${RULE};`;
    return `<tr>
<td width="132" valign="top" style="width:132px;padding:10px 14px;${edge}font-size:12px;font-weight:600;line-height:1.5;color:${QUIET_INK};text-transform:uppercase;letter-spacing:0.4px;${WRAP}">${escapeHtml(row.label)}</td>
<td valign="top" style="padding:10px 14px;${edge}font-size:14px;line-height:1.5;color:${INK};${WRAP}">${escapeHtml(row.value)}</td>
</tr>`;
  });
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#fbfbfd" style="width:100%;table-layout:fixed;background:#fbfbfd;border:1px solid ${RULE};border-radius:6px;border-collapse:separate;margin:0 0 20px">
${cells.join('\n')}
</table>`;
}

/**
 * What the reader is told before they click Join, set apart so it is not read
 * as small print.
 *
 * It states its own background as well as its own colour: this is the one
 * block that must survive a client forcing dark mode, and quiet grey text with
 * no background of its own is exactly what such a client repaints into grey on
 * grey.
 */
export function noticeBlock(paragraphs: readonly string[]): string {
  const said = paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
  if (said.length === 0) return '';
  const body = said
    .map((p, i) => `<p style="margin:0 0 ${i === said.length - 1 ? '0' : '10px'};font-size:13px;line-height:1.6;color:${INK}">${escapeHtml(p)}</p>`)
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${NOTICE_BG}" style="width:100%;table-layout:fixed;background:${NOTICE_BG};border:1px solid ${RULE};border-left:3px solid ${ACCENT};border-radius:4px;border-collapse:separate;margin:0 0 20px">
<tr><td style="padding:14px 16px">
${body}
</td></tr></table>`;
}

/**
 * A mail header is a single line. Names and role titles typed by people reach
 * subject lines; a newline inside one would let a stranger append headers to
 * mail sent on Questor's behalf. Every control character becomes a space and
 * the length is bounded. Written as a code-point test rather than a regex
 * character class, so no control character has to survive a source literal.
 */
export function headerSafe(value: string): string {
  const SPACE = 32;
  const DEL = 127;
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < SPACE || code === DEL ? ' ' : ch;
  }
  return out.trim().slice(0, 120);
}

/**
 * For text a person typed that is placed inside a PLAIN-TEXT body.
 *
 * The text body has no tags to escape, which is exactly why it gets forgotten
 * — and it is the half that needs this most. A line break inside a role title
 * would let whoever wrote the job description add a line to a letter the
 * candidate reads as coming from the company: "Start your interview:" followed
 * by an address of their choosing. The same body is copied into the calendar
 * entry's description, so it travels further than the email.
 *
 * `headerSafe`'s code-point test, without its 120-character cap: a body has
 * room for a real role title, and truncating one mid-word in the middle of a
 * sentence looks like a bug.
 */
export function textSafe(value: string): string {
  const SPACE = 32;
  const DEL = 127;
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < SPACE || code === DEL ? ' ' : ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

/** For text a person typed that is placed inside an HTML body. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
