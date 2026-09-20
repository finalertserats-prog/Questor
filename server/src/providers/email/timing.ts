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
 * SMTP conversation — are derived here as a first line. They bound silence,
 * not time: a relay that keeps answering slowly can outlast them, which is
 * why the SMTP send runs in a child process that is killed outright at
 * SMTP_KILL_DEADLINE_MS (smtpChild.ts). tests/emailSmtpTimeouts.test.ts proves
 * the lock outlives that deadline.
 *
 * Kept out of providers/email/index.ts so the sender can import the constant
 * without importing the providers, which import the sender's callers.
 */

export const EMAIL_SEND_TIMEOUT_MS = 60_000;

/**
 * When the SMTP child is killed, whatever it is doing. The send timeout
 * itself: past this point the sender has given up, and the kill is what
 * makes "given up" true on the wire as well.
 */
export const SMTP_KILL_DEADLINE_MS = EMAIL_SEND_TIMEOUT_MS;

/**
 * The provider did not answer in time. Distinct from a refusal, because it
 * means something different: a refusal is an outcome, a timeout is not one.
 * Thrown by the feedback sender's own race and by the SMTP child driver when
 * it kills the child, so the sender treats both the same way.
 */
export class SendTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`The mail provider did not answer within ${seconds}s.`);
    this.name = 'SendTimeoutError';
  }
}

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

/**
 * The per-phase budget added up. Honest about what it is: a bound on how long
 * the transport tolerates silence in each phase, not on the conversation as a
 * whole — a server that keeps talking slowly is bounded by the kill instead.
 */
export function smtpPhaseBudgetMs(t: SmtpTimeouts = SMTP_TIMEOUTS): number {
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
