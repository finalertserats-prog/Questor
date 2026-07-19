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
  send(msg: EmailMessage): Promise<{ status: string; id: string }>;
}

class ConsoleEmailProvider implements EmailProvider {
  name = 'console';
  configured = true;
  async send(msg: EmailMessage) {
    logger.info({ to: msg.to, subject: msg.subject }, `📧 [console email] ${msg.subject} -> ${msg.to}`);
    logger.info(`\n----- EMAIL BODY -----\n${msg.text}\n----------------------`);
    return { status: 'sent', id: `console-${Date.now()}` };
  }
}

class SendgridEmailProvider implements EmailProvider {
  name = 'sendgrid';
  configured = true;
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

let cached: EmailProvider | null = null;
export function getEmail(): EmailProvider {
  if (cached) return cached;
  if (config.email.provider === 'sendgrid' && config.email.sendgridKey) {
    cached = new SendgridEmailProvider(config.email.sendgridKey);
  } else {
    if (config.email.provider !== 'console') {
      logger.warn(`Email provider "${config.email.provider}" not fully configured; using console.`);
    }
    cached = new ConsoleEmailProvider();
  }
  return cached;
}
