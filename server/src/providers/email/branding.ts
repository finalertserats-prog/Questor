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
export function brandedEmail(message: EmailMessage): EmailMessage {
  const wordmark = `${config.webOrigin.replace(/\/+$/, '')}/brand/questor-wordmark.png`;
  const html = `<div style="font-family:Segoe UI,system-ui,-apple-system,sans-serif;color:#1a1a22;font-size:15px;line-height:1.55;max-width:560px">
<img src="${wordmark}" alt="Questor" width="180" style="width:180px;max-width:60%;height:auto;margin:0 0 18px">
${message.html}
<hr style="border:0;border-top:1px solid #d8d8e2;margin:22px 0 10px">
<p style="color:#5a5a6e;font-size:12px;margin:0">Questor — The intelligence behind every hire.</p>
</div>`;

  return { ...message, html };
}
