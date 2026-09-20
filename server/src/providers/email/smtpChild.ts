import { fork, type ChildProcess } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.js';
import { SendTimeoutError } from './timing.js';

/**
 * Drives one SMTP send in a child process (smtpSender.ts) and kills it at
 * the deadline.
 *
 * WHY A PROCESS. The feedback sender holds a lock while a letter is being
 * sent and lets a review through only once that lock has expired. That is
 * only safe if nothing can be delivered after the expiry. SendGrid is a
 * fetch and can be aborted. nodemailer cannot, and its timeouts measure
 * silence, not time: a relay that keeps answering slowly can outlast any
 * deadline. Killing the process is the one thing that ends the conversation
 * for certain — the OS closes the socket, and an SMTP server does not accept
 * a message whose DATA was never terminated. The single ambiguous case, the
 * terminator sent and the final 250 not yet received, happened before the
 * deadline and so inside the lock; the caller records it as unconfirmed.
 *
 * WHAT THE CHILD GETS. The transport settings and the message, over IPC, and
 * an environment of the few variables a Node process needs to run at all.
 * Not our environment, so nothing else leaks into it; and nothing about the
 * transport is ever logged by either side.
 */

const SENDER_BASENAME = 'smtpSender';

/** The variables a Node child needs to start and to resolve a hostname; nothing of ours. */
const INHERITED_ENV = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];

let senderScript: string | null = null;

/** Test hook: run a different child script (a crashing one, a missing one). */
export function _setSmtpSenderScriptForTest(path: string | null): void {
  senderScript = path;
}

/**
 * The sender script beside this file, with this file's own extension: the
 * TypeScript source under tests and tsx, the emitted JavaScript in dist. tsx
 * is only asked for when the source is what is being run.
 */
function senderCommand(): { script: string; execArgv: string[] } {
  if (senderScript) return { script: senderScript, execArgv: [] };
  const ext = extname(fileURLToPath(import.meta.url));
  const script = fileURLToPath(new URL(`./${SENDER_BASENAME}${ext}`, import.meta.url));
  return { script, execArgv: ext === '.ts' ? ['--import', 'tsx'] : [] };
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

const inFlight = new Set<ChildProcess>();

/** How many sender processes are running right now. */
export function inFlightSmtpSenders(): number {
  return inFlight.size;
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

/** Shutdown: kill every sender still running and wait for it to be gone. */
export async function killInFlightSmtpSenders(): Promise<void> {
  const children = [...inFlight];
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map(exited));
}

type Reply =
  | { readonly type: 'sent'; readonly messageId: string }
  | { readonly type: 'failed'; readonly message: string };

export interface SmtpChildSend {
  readonly transport: Record<string, unknown>;
  readonly mail: Record<string, unknown>;
  /** Kill the child and give up after this long, whatever it is doing. */
  readonly deadlineMs: number;
  /** Test hook: the child's pid once it is running. */
  readonly onStarted?: (pid: number) => void;
}

/**
 * Send one message. Resolves with the provider's id; rejects with
 * SendTimeoutError at the deadline (the child is dead by then) or with a
 * plain Error for a definite failure — the server refused, the child crashed,
 * or the child could not be started at all.
 */
export function sendViaSmtpChild(send: SmtpChildSend): Promise<{ messageId: string }> {
  return new Promise((resolve, reject) => {
    const { script, execArgv } = senderCommand();
    let child: ChildProcess;
    try {
      child = fork(script, [], { execArgv, env: childEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
    } catch (err) {
      reject(new Error(`The mail sender process could not be started: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    inFlight.add(child);

    let settled = false;
    let stderr = '';
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const finish = () => {
      inFlight.delete(child);
    };

    const timer = setTimeout(() => {
      // SIGKILL, not SIGTERM: nothing in the child is allowed a last word,
      // least of all the DATA terminator.
      child.kill('SIGKILL');
      settle(() => reject(new SendTimeoutError(Math.round(send.deadlineMs / 1000))));
    }, send.deadlineMs);
    timer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => { stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000); });
    child.on('error', (err) => {
      settle(() => reject(new Error(`The mail sender process could not be started: ${err.message}`)));
    });
    // The reply is kept until the child has actually gone, so that a settled
    // promise always means there is no process left holding a socket.
    let reply: Reply | null = null;
    child.on('message', (message: Reply) => {
      if (message?.type === 'sent' || message?.type === 'failed') reply = message;
    });
    child.on('exit', (code, signal) => {
      finish();
      settle(() => {
        if (reply?.type === 'sent') { resolve({ messageId: reply.messageId }); return; }
        if (reply?.type === 'failed') { reject(new Error(reply.message)); return; }
        // No reply and no timeout: the child died on us. A definite failure —
        // nothing was sent — and worth a line in the log, minus anything the
        // child might have printed about the transport (it prints nothing).
        logger.error({ code, signal, stderr: stderr.trim().slice(0, 500) }, 'The mail sender process exited without a result');
        reject(new Error(`The mail sender process exited before sending (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`));
      });
    });
    child.on('spawn', () => {
      send.onStarted?.(child.pid ?? 0);
      child.send({ type: 'send', transport: send.transport, mail: send.mail }, (err) => {
        if (err) settle(() => reject(new Error(`The mail sender process could not be given the message: ${err.message}`)));
      });
    });
  });
}
