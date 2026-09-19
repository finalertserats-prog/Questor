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
 * A button that still works when links do not. Gmail disables every link in a
 * message it files as spam, and some company mail systems strip them; an
 * address that lived only inside the button left a candidate with the words
 * "Start or schedule your interview" and nothing to click or copy. So the
 * address is always written out underneath as plain text.
 */
export function emailButton(href: string, label: string): string {
  const url = escapeHtml(href);
  return `<p style="margin:0 0 8px"><a href="${url}" style="display:inline-block;background:#2f2f7a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600">${escapeHtml(label)}</a></p>
<p style="margin:0 0 14px;color:#5a5a6e;font-size:13px">If the button does not work, copy this link into your browser:<br><span style="color:#1a1a22;word-break:break-all">${url}</span></p>`;
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

/** For text a person typed that is placed inside an HTML body. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
