/**
 * How long a single email send may take, and how that bounds SMTP.
 *
 * One constant, because two things depend on agreeing about it: the feedback
 * sender gives up on a provider after EMAIL_SEND_TIMEOUT_MS and then holds a
 * lock for that long plus a grace period (services/autoFeedback.ts), and a
 * review may be completed only once the lock has gone. SendGrid is a fetch and
 * can be aborted at the timeout. SMTP cannot: a hung sendMail keeps running,
 * and if it ran past the lock it could deliver a letter a reviewer had already
 * corrected. So the transport's own timeouts — the only thing that ends a hung
 * SMTP conversation — are derived here so that every phase together can never
 * outlast the send timeout, and tests/emailSmtpTimeouts.test.ts proves the
 * lock outlives them.
 *
 * Kept out of providers/email/index.ts so the sender can import the constant
 * without importing the providers, which import the sender's callers.
 */

export const EMAIL_SEND_TIMEOUT_MS = 60_000;

/**
 * nodemailer runs the phases one after another: resolve the host, connect,
 * wait for the greeting, then exchange commands (socketTimeout is the longest
 * silence tolerated at any point in that exchange). Each gets a quarter, so
 * the longest a send can run is the send timeout itself.
 */
const PHASE_MS = EMAIL_SEND_TIMEOUT_MS / 4;

export interface SmtpTimeouts {
  readonly dnsTimeout: number;
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
}

export const SMTP_TIMEOUTS: SmtpTimeouts = {
  dnsTimeout: PHASE_MS,
  connectionTimeout: PHASE_MS,
  greetingTimeout: PHASE_MS,
  socketTimeout: PHASE_MS,
};

function timeoutsFor(sendTimeoutMs: number): SmtpTimeouts {
  const phase = Math.max(1, Math.floor(sendTimeoutMs / 4));
  return { dnsTimeout: phase, connectionTimeout: phase, greetingTimeout: phase, socketTimeout: phase };
}

/** The longest a sendMail can run before the transport itself gives up. */
export function smtpMaxLifetimeMs(t: SmtpTimeouts = SMTP_TIMEOUTS): number {
  return t.dnsTimeout + t.connectionTimeout + t.greetingTimeout + t.socketTimeout;
}

export interface SmtpConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
}

/**
 * The options the SMTP transport is created with. `secure` is implicit TLS
 * (port 465); everything else negotiates STARTTLS, which nodemailer does on
 * its own when the server advertises it.
 */
export function smtpTransportOptions(o: SmtpConnection, sendTimeoutMs: number = EMAIL_SEND_TIMEOUT_MS) {
  return {
    host: o.host,
    port: o.port,
    secure: o.port === 465,
    auth: { user: o.user, pass: o.pass },
    ...timeoutsFor(sendTimeoutMs),
  };
}
