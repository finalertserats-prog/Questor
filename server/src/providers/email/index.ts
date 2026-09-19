import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

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
  send(msg: EmailMessage): Promise<{ status: string; id: string }>;
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
  async send(msg: EmailMessage) {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
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
  // Typed loosely because nodemailer's Transporter generic pulls in its whole
  // type surface for no benefit here; the two calls used are stable.
  private transport: { sendMail: (o: Record<string, unknown>) => Promise<{ messageId?: string }>; verify: () => Promise<boolean> };

  constructor(o: { host: string; port: number; user: string; pass: string }) {
    // `secure` is implicit-TLS (port 465). Everything else negotiates STARTTLS,
    // which nodemailer does automatically when the server advertises it.
    this.transport = nodemailer.createTransport({
      host: o.host, port: o.port, secure: o.port === 465,
      auth: { user: o.user, pass: o.pass },
    }) as never;
  }

  /** Prove the credentials work without sending anything to a candidate. */
  async verify(): Promise<void> { await this.transport.verify(); }

  async send(msg: EmailMessage) {
    const info = await this.transport.sendMail({
      from: config.email.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html,
    });
    return { status: 'sent', id: info.messageId ?? 'smtp' };
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
