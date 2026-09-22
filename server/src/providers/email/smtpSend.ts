import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.js';
import { EMAIL_SEND_TIMEOUT_MS, EmailSendTimeoutError } from './timing.js';
import { smtpChildResponseSchema, type SmtpChildMessage, type SmtpChildRequest } from './smtpSendProtocol.js';

/**
 * Running the SMTP send somewhere it can be killed.
 *
 * The send lock on a candidate's feedback row (services/autoFeedback.ts) is
 * what stops a letter going out after a reviewer has corrected it, and a lock
 * is only as good as the guarantee that the send ends before it expires.
 * nodemailer gives no such guarantee: it cannot be aborted, and its
 * socketTimeout bounds silence rather than time, so a relay that answers each
 * command just inside the timeout stays under it for ever. The only thing that
 * reliably ends a TCP conversation is the process owning the socket dying.
 *
 * So the send happens in a forked child, and at the deadline the child is
 * SIGKILLed. The kernel closes the socket; the message body was never
 * terminated with CRLF.CRLF, so no SMTP server can have accepted it, and
 * acceptance after the deadline becomes impossible rather than unlikely.
 *
 * The one case left is narrow and was always there: we sent the terminator and
 * the server's 250 had not arrived when we killed. That acceptance happened
 * BEFORE the deadline, inside the lock, and the caller records it exactly as
 * it records any unanswered send — as unconfirmed, never as a retry.
 *
 * Anything else — a child that will not start, or dies without reporting — is
 * a DEFINITE failure: nothing can have been accepted without a body, so the
 * caller releases the lock and retries normally. The exception is a kill we
 * ordered ourselves at shutdown, which means what the deadline's kill means.
 */

const HERE = fileURLToPath(import.meta.url);
/**
 * In development and tests this module is the .ts source run through tsx; in
 * production it is the .js that tsc emitted beside it. The child has to match
 * its parent, and a TypeScript child needs the loader that a compiled one must
 * not be given.
 */
const FROM_SOURCE = HERE.endsWith('.ts');
const CHILD_SCRIPT = join(dirname(HERE), FROM_SOURCE ? 'smtpSendChild.ts' : 'smtpSendChild.js');
const CHILD_EXEC_ARGV = FROM_SOURCE ? ['--import', 'tsx'] : [];

/** How long to wait for a killed child to actually be gone before giving up on it. */
const REAP_TIMEOUT_MS = 5_000;
/** Enough of the child's stderr to diagnose a crash, and not enough to fill a log. */
const STDERR_KEPT = 2_000;

export interface SmtpChildSendOptions {
  /** The hard deadline for the whole send, after which the child is killed. */
  readonly deadlineMs?: number;
  /** The caller gave up first (its own timeout); the child is killed the same way. */
  readonly signal?: AbortSignal;
  /** The sender script. Only the tests pass this, to stand in a child that misbehaves. */
  readonly script?: string;
  /** The child's pid, the moment it exists. For tests that check nothing is left running. */
  readonly onSpawn?: (pid: number) => void;
}

/**
 * Every child currently sending, and how to tell its caller the send was ended
 * from outside. Killed on shutdown, so a stopping process never leaves an SMTP
 * conversation running with nobody to record its outcome.
 */
const inFlight = new Map<ChildProcess, () => void>();

/**
 * Stop every send in progress. Called by the shutdown drain (src/index.ts).
 *
 * Reported to each caller as an unknown outcome, not a failure: this is the
 * deadline's kill by another name, and the message may have been accepted in
 * the moment before the socket closed. A failure would be retried, and a retry
 * of a letter that did go is a second copy in the candidate's inbox.
 */
export function killInFlightSmtpSends(): number {
  const killed = inFlight.size;
  for (const [child, abandon] of inFlight) {
    abandon();
    child.kill('SIGKILL');
  }
  inFlight.clear();
  if (killed > 0) logger.warn({ killed }, 'Stopped SMTP sends still in flight at shutdown');
  return killed;
}

/** Resolves once the child is really gone, so no test and no shutdown leaves a zombie. */
function killAndReap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const giveUp = setTimeout(resolve, REAP_TIMEOUT_MS);
    giveUp.unref?.();
    child.once('exit', () => { clearTimeout(giveUp); resolve(); });
    child.kill('SIGKILL');
  });
}

/**
 * Send one message through a child process, and kill that child if it is still
 * going at the deadline.
 *
 * Rejects with EmailSendTimeoutError when we ended it ourselves — the deadline,
 * the caller's signal or a shutdown — which is an unknown outcome, and with a
 * plain Error for anything the child reported or suffered, which is a definite
 * failure the caller may retry.
 */
export async function sendSmtpInChild(
  transport: Record<string, unknown>,
  message: SmtpChildMessage,
  opts: SmtpChildSendOptions = {},
): Promise<{ messageId: string }> {
  const deadlineMs = opts.deadlineMs ?? EMAIL_SEND_TIMEOUT_MS;
  let settle: (outcome: { messageId: string } | { error: Error }) => void = () => {};
  const settled = new Promise<{ messageId: string } | { error: Error }>((resolve) => { settle = resolve; });

  const child = fork(opts.script ?? CHILD_SCRIPT, [], {
    execArgv: opts.script ? [] : CHILD_EXEC_ARGV,
    // No stdin, no stdout: the transport options carry the mailbox password and
    // nothing in this child may print. stderr is kept only to explain a crash.
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  // Registered before anything can go wrong with it, so a shutdown mid-startup
  // still finds the child and still answers its caller.
  inFlight.set(child, () => settle({ error: new EmailSendTimeoutError(deadlineMs) }));
  if (child.pid !== undefined) opts.onSpawn?.(child.pid);

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_KEPT) stderr += chunk.toString('utf8');
  });

  child.on('message', (raw: unknown) => {
    const parsed = smtpChildResponseSchema.safeParse(raw);
    if (!parsed.success) {
      settle({ error: new Error('The SMTP sender answered with something unreadable.') });
      return;
    }
    settle(parsed.data.ok ? { messageId: parsed.data.messageId } : { error: new Error(parsed.data.error) });
  });
  // Nothing was sent: a child that could not start never opened a socket, and
  // one that died without reporting never terminated a message body.
  child.on('error', (err: Error) => settle({ error: new Error(`The SMTP sender could not be started: ${err.message}`) }));
  child.on('exit', (code, signal) => settle({
    error: new Error(`The SMTP sender exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''} before reporting${stderr ? `: ${stderr.trim()}` : ''}.`),
  }));

  const timer = setTimeout(() => settle({ error: new EmailSendTimeoutError(deadlineMs) }), deadlineMs);
  timer.unref?.();
  const onAbort = () => settle({ error: new EmailSendTimeoutError(deadlineMs) });
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const request: SmtpChildRequest = { transport, message };
    child.send(request, (err: Error | null) => {
      if (err) settle({ error: new Error(`The SMTP sender could not be reached: ${err.message}`) });
    });
    const outcome = await settled;
    if ('error' in outcome) throw outcome.error;
    return { messageId: outcome.messageId };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    // Always, however it ended: the send is over for us, so the child has no
    // business still holding a socket open to a mail server.
    await killAndReap(child);
    inFlight.delete(child);
  }
}
