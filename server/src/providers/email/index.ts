import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { EMAIL_SEND_TIMEOUT_MS, SMTP_KILL_DEADLINE_MS, smtpTransportOptions } from './timing.js';
import { sendViaSmtpChild } from './smtpChild.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  name: string;
  configured: boolean;
  /**
   * Whether mail actually reaches the recipient.
   *
   * Separate from `configured` because the console provider is perfectly
   * configured and delivers nothing. Conflating the two is how invitations were
   * reported as sent to candidates who never received them — the recruiter saw
   * success, the candidate saw silence, and nobody found out until someone
   * asked why there were no interviews.
   */
  delivers: boolean;
  /**
   * `signal`, where a provider can honour it, stops the request: a caller
   * that has given up waiting can at least stop what it still holds. SMTP
   * cannot be aborted mid-conversation and ignores it; the caller must treat
   * a timed-out send as one that may still have gone.
   */
  send(msg: EmailMessage, opts?: { readonly signal?: AbortSignal }): Promise<{ status: string; id: string }>;
}

class ConsoleEmailProvider implements EmailProvider {
  name = 'console';
  configured = true;
  delivers = false;
  async send(msg: EmailMessage) {
    // Production may run on this provider (ALLOW_UNDELIVERED_EMAIL). There the
    // address is personal data an erasure cannot reach once it is in a log
    // sink, and the body carries bearer links (the candidate portal, sign-in,
    // feedback). Some subjects name the person too. Only a developer's own
    // machine gets any of it.
    if (config.nodeEnv !== 'development') {
      logger.info({ delivered: false }, '📧 [console email — NOT DELIVERED]');
      return { status: 'logged', id: `console-${Date.now()}` };
    }
    logger.info({ to: msg.to, subject: msg.subject }, `📧 [console email — NOT DELIVERED] ${msg.subject} -> ${msg.to}`);
    logger.info(`\n----- EMAIL BODY -----\n${msg.text}\n----------------------`);
    // 'logged', never 'sent'. The caller decides what to tell the user, and it
    // cannot decide honestly if this lies about what happened.
    return { status: 'logged', id: `console-${Date.now()}` };
  }
}

class SendgridEmailProvider implements EmailProvider {
  name = 'sendgrid';
  configured = true;
  delivers = true;
  constructor(private key: string) {}
  async send(msg: EmailMessage, opts: { readonly signal?: AbortSignal } = {}) {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      // Never unbounded. Only the feedback sender ever passed a signal, so a
      // stalled SendGrid could hold an identity code, a reminder, the digest
      // or a signup open indefinitely — and the identity code is sent inside
      // the candidate's own request (docs/qa/resilience-2026-09-23.md, §1.5).
      // SMTP has the child-process kill; this is SendGrid's equivalent.
      signal: opts.signal ?? AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: config.email.from },
        subject: msg.subject,
        content: [
          { type: 'text/plain', value: msg.text },
          { type: 'text/html', value: msg.html },
        ],
      }),
    });
    if (!res.ok) throw new Error(`SendGrid error ${res.status}`);
    return { status: 'sent', id: res.headers.get('x-message-id') ?? 'sendgrid' };
  }
}

/**
 * SMTP, for teams that already have a mailbox rather than a transactional-email
 * account — which is most small teams. Sending invitations from the company's
 * own domain also matters for deliverability: an interview link arriving from an
 * unfamiliar sender is exactly what a candidate is taught to treat as phishing.
 */
class SmtpEmailProvider implements EmailProvider {
  name = 'smtp';
  configured = true;
  delivers = true;
  private readonly options: ReturnType<typeof smtpTransportOptions>;
  // Typed loosely because nodemailer's Transporter generic pulls in its whole
  // type surface for no benefit here; the one call used is stable.
  private readonly transport: { verify: () => Promise<boolean> };

  constructor(o: { host: string; port: number; user: string; pass: string }) {
    // Every timeout the transport has is set (providers/email/timing.ts) as a
    // first line. The send itself runs in a child process that is killed at
    // the deadline (smtpChild.ts): an SMTP send cannot be aborted, and only
    // ending the process ends the conversation for certain.
    this.options = smtpTransportOptions(o);
    this.transport = nodemailer.createTransport(this.options) as never;
  }

  /** Prove the credentials work without sending anything to a candidate. */
  async verify(): Promise<void> { await this.transport.verify(); }

  /**
   * `signal` is ignored: SMTP cannot be aborted mid-conversation. The child
   * is killed at SMTP_KILL_DEADLINE_MS instead, which the caller sees as a
   * SendTimeoutError.
   */
  async send(msg: EmailMessage) {
    const info = await sendViaSmtpChild({
      transport: this.options,
      mail: { from: config.email.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html },
      deadlineMs: SMTP_KILL_DEADLINE_MS,
    });
    return { status: 'sent', id: info.messageId };
  }
}

let cached: EmailProvider | null = null;
export function getEmail(): EmailProvider {
  if (cached) return cached;
  const { provider, sendgridKey, smtpHost, smtpPort, smtpUser, smtpPass } = config.email;

  if (provider === 'sendgrid' && sendgridKey) {
    cached = new SendgridEmailProvider(sendgridKey);
  } else if (provider === 'smtp' && smtpHost && smtpUser && smtpPass) {
    cached = new SmtpEmailProvider({ host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass });
  } else {
    // Falling back silently is how invitations got dropped. Say plainly that
    // nothing will reach a candidate, and say which setting is missing.
    if (provider !== 'console') {
      logger.error(
        `EMAIL_PROVIDER="${provider}" is selected but not fully configured` +
        (provider === 'smtp' ? ' (needs SMTP_HOST, SMTP_USER, SMTP_PASS)' : ' (needs SENDGRID_API_KEY)') +
        ' — falling back to console. NO INVITATION EMAIL WILL REACH ANY CANDIDATE.',
      );
    }
    cached = new ConsoleEmailProvider();
  }
  return cached;
}

/** Test hook — forces the next getEmail() to re-read config. */
export function _resetEmail() { cached = null; }
