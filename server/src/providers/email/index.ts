import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { sendSmtpInChild } from './smtpSend.js';
import { EMAIL_SEND_TIMEOUT_MS, smtpTransportOptions, type SmtpConnection } from './timing.js';

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
   * `signal` stops the request: a caller that has given up waiting can at
   * least close the socket. SendGrid aborts its fetch; SMTP, which cannot be
   * aborted mid-conversation, kills the child process holding the connection.
   * Either way the caller must still treat a timed-out send as one that may
   * already have been accepted.
   */
  send(msg: EmailMessage, opts?: { readonly signal?: AbortSignal }): Promise<{ status: string; id: string }>;
}

class ConsoleEmailProvider implements EmailProvider {
  name = 'console';
  configured = true;
  delivers = false;
  async send(msg: EmailMessage) {
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
      signal: opts.signal,
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

export interface SmtpProviderOptions {
  /** The per-phase transport timeouts are derived from this. */
  readonly sendTimeoutMs?: number;
  /**
   * The hard deadline after which the sending child is killed. One number with
   * sendTimeoutMs in production; the tests move the two apart so it is clear
   * which line of defence ended a send.
   */
  readonly deadlineMs?: number;
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
  private readonly transportOptions: Record<string, unknown>;
  private readonly deadlineMs: number;
  // Typed loosely because nodemailer's Transporter generic pulls in its whole
  // type surface for no benefit here; the one call used is stable.
  private readonly transport: { verify: () => Promise<boolean> };

  constructor(o: SmtpConnection, opts: SmtpProviderOptions = {}) {
    const sendTimeoutMs = opts.sendTimeoutMs ?? EMAIL_SEND_TIMEOUT_MS;
    // Every timeout the transport has is set (providers/email/timing.ts), as a
    // first line of defence against a relay that simply stops answering.
    this.transportOptions = smtpTransportOptions(o, sendTimeoutMs);
    this.deadlineMs = opts.deadlineMs ?? sendTimeoutMs;
    this.transport = nodemailer.createTransport(this.transportOptions) as never;
  }

  /** Prove the credentials work without sending anything to a candidate. */
  async verify(): Promise<void> { await this.transport.verify(); }

  /**
   * The send runs in a child process, which is killed at the deadline
   * (providers/email/smtpSend.ts). Those timeouts above bound silence only: a
   * relay that keeps answering slowly is never idle, and only killing the
   * process that owns the socket can stop it delivering after the feedback
   * send lock has expired.
   */
  async send(msg: EmailMessage, opts: { readonly signal?: AbortSignal } = {}) {
    const info = await sendSmtpInChild(
      this.transportOptions,
      { from: config.email.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html },
      { deadlineMs: this.deadlineMs, signal: opts.signal },
    );
    return { status: 'sent', id: info.messageId };
  }
}

/** The SMTP provider on its own, for a caller that has its own connection settings. */
export function createSmtpProvider(connection: SmtpConnection, opts: SmtpProviderOptions = {}): EmailProvider {
  return new SmtpEmailProvider(connection, opts);
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
