import nodemailer from 'nodemailer';
import {
  CHILD_REQUEST_WAIT_MS, EXIT_BAD_REQUEST, EXIT_NO_REQUEST,
  smtpChildRequestSchema, type SmtpChildResponse,
} from './smtpSendProtocol.js';

/**
 * One SMTP send, in a process whose only job is that send.
 *
 * It exists to be killable. nodemailer offers no way to abandon a sendMail:
 * the promise never settles early and the socket stays open, so the only thing
 * that can truly end a conversation with a slow relay is the operating system
 * closing the socket — which happens when this process dies. The parent
 * (smtpSend.ts) kills it at the deadline, and because the message body was
 * never terminated the relay cannot have accepted it.
 *
 * Deliberately small: nodemailer, the protocol schemas and nothing else. No
 * config, no logger, no database. It prints nothing — the transport options it
 * is handed contain the mailbox password, and stdout is not a safe place for
 * them — and reports its one result over IPC.
 */

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function report(response: SmtpChildResponse, code: number): void {
  // Sending is asynchronous: exiting before the channel has flushed loses the
  // result and the parent would read a crash where there was an answer.
  process.send?.(response, () => process.exit(code));
}

/** A child nobody ever speaks to must not become a process nobody ever reaps. */
const idleExit = setTimeout(() => process.exit(EXIT_NO_REQUEST), CHILD_REQUEST_WAIT_MS);

async function run(raw: unknown): Promise<void> {
  clearTimeout(idleExit);
  const parsed = smtpChildRequestSchema.safeParse(raw);
  if (!parsed.success) {
    // Nothing was sent, so this is a definite failure and the parent may retry.
    report({ ok: false, error: 'The SMTP sender was given a request it could not read.' }, EXIT_BAD_REQUEST);
    return;
  }
  const transport = nodemailer.createTransport(parsed.data.transport);
  try {
    const info = await transport.sendMail({ ...parsed.data.message });
    report({ ok: true, messageId: info.messageId ?? 'smtp' }, 0);
  } catch (err) {
    report({ ok: false, error: describe(err) }, 0);
  } finally {
    transport.close();
  }
}

process.once('message', (raw: unknown) => { void run(raw); });
// The parent going away takes the send with it; there is nobody left to tell.
process.once('disconnect', () => process.exit(EXIT_NO_REQUEST));
