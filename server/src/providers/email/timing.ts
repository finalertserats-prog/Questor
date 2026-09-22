/**
 * How long a single email send may take, and how that bounds SMTP.
 *
 * One constant, because two things depend on agreeing about it: the feedback
 * sender gives up on a provider after EMAIL_SEND_TIMEOUT_MS and then holds a
 * lock for that long plus a grace period (services/autoFeedback.ts), and a
 * review may be completed only once the lock has gone. SendGrid is a fetch and
 * can be aborted at the timeout, which closes its socket.
 *
 * SMTP cannot be aborted at all, and its transport timeouts are NOT a budget:
 * socketTimeout bounds silence, so a relay that answers every command just
 * inside it — greeting, EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA, the
 * final 250 — is never idle and can keep a sendMail running for minutes. Past
 * the lock, that relay could accept a letter a reviewer had already corrected.
 * So the SMTP send runs in a child process (providers/email/smtpSend.ts) that
 * is killed outright at the deadline; the OS closes the socket mid-message,
 * and a message whose body was never terminated cannot be accepted. The phase
 * timeouts below stay as the first line of defence — they end the ordinary
 * hung connection without spending the whole budget — and
 * tests/emailSmtpTimeouts.test.ts holds the deadline strictly inside the lock.
 *
 * Kept out of providers/email/index.ts so the sender can import the constant
 * without importing the providers, which import the sender's callers.
 */

export const EMAIL_SEND_TIMEOUT_MS = 60_000;

/**
 * nodemailer runs the phases one after another: resolve the host, connect,
 * wait for the greeting, then exchange commands. Each gets a quarter of the
 * send timeout, so no single stretch of silence can spend the whole budget.
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
 * The longest ONE UNINTERRUPTED SILENCE the transport tolerates, added up over
 * its phases. Emphatically not a bound on how long a send can run: every byte
 * from the server starts the socket timeout again. Only the hard deadline
 * bounds a send.
 */
export function smtpIdleBudgetMs(t: SmtpTimeouts = SMTP_TIMEOUTS): number {
  return t.dnsTimeout + t.connectionTimeout + t.greetingTimeout + t.socketTimeout;
}

/**
 * The deadline passed and the send was ended by force. Distinct from a refusal
 * because it means something different: a refusal is an outcome, this is the
 * absence of one — the message may or may not have been accepted before the
 * socket closed, and the caller must record it as unknown rather than retry it.
 */
export class EmailSendTimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`The mail provider did not answer within ${Math.round(ms / 1000)}s.`);
    this.name = 'EmailSendTimeoutError';
  }
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
