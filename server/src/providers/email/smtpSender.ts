import nodemailer from 'nodemailer';

/**
 * The SMTP send, run in a process of its own.
 *
 * nodemailer cannot be aborted, and its socket timeout only measures silence:
 * a relay that answers slowly but never stops answering can keep a send alive
 * past any deadline. The parent (smtpChild.ts) therefore runs the send here
 * and, at the deadline, kills this process outright. The operating system
 * then closes the socket, and a message whose DATA was never terminated
 * cannot be accepted by any SMTP server.
 *
 * Everything this process needs arrives over IPC; nothing is read from the
 * environment and nothing about the transport is ever logged. It handles one
 * send and exits.
 */

interface SendRequest {
  readonly type: 'send';
  readonly transport: Record<string, unknown>;
  readonly mail: Record<string, unknown>;
}

type SendReply =
  | { readonly type: 'sent'; readonly messageId: string }
  | {
    readonly type: 'failed';
    readonly message: string;
    /**
     * The SMTP reply code, where the relay gave one. The parent needs it to
     * tell a refusal (nothing was delivered) from a connection that died
     * mid-conversation (outcome unknown) — see providers/email/failure.ts.
     */
    readonly responseCode?: number;
    /** nodemailer's own class of failure: ECONNECTION, EAUTH, ESOCKET, EENVELOPE. */
    readonly code?: string;
  };

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function reply(message: SendReply): void {
  if (process.send) process.send(message);
}

process.on('message', (request: SendRequest) => {
  if (!request || request.type !== 'send') return;
  const transport = nodemailer.createTransport(request.transport as never) as unknown as {
    sendMail: (o: Record<string, unknown>) => Promise<{ messageId?: string }>;
  };
  transport.sendMail(request.mail)
    .then((info) => {
      reply({ type: 'sent', messageId: info.messageId ?? 'smtp' });
      process.exit(0);
    })
    .catch((err: unknown) => {
      // The message and the two codes: a transport error can quote the
      // server's reply, never our credentials, and the parent truncates it
      // before storing. The codes are what tell "refused" from "unknown".
      const e = (err ?? {}) as { responseCode?: unknown; code?: unknown };
      reply({
        type: 'failed',
        message: err instanceof Error ? err.message : String(err),
        ...(numberOrUndefined(e.responseCode) !== undefined ? { responseCode: numberOrUndefined(e.responseCode) } : {}),
        ...(stringOrUndefined(e.code) !== undefined ? { code: stringOrUndefined(e.code) } : {}),
      });
      process.exit(0);
    });
});

// Orphaned by a parent that died without killing us: do not linger.
process.on('disconnect', () => process.exit(0));
