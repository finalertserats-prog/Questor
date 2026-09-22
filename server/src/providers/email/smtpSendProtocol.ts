import { z } from 'zod';

/**
 * What the parent and the SMTP child process say to each other over IPC.
 *
 * A process boundary, so both ends validate: the child will not build a
 * transport out of a message it cannot recognise, and the parent will not
 * report a send on the strength of a reply it cannot recognise either. Kept in
 * its own module so the parent can import the schemas without importing the
 * child script, which starts listening the moment it is loaded.
 */

export const smtpChildMessageSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
});

export const smtpChildRequestSchema = z.object({
  /**
   * The nodemailer transport options, built by the parent from config. They
   * carry the mailbox password, so they are handed over IPC — never through
   * argv, an environment variable or a log line.
   */
  transport: z.record(z.unknown()),
  message: smtpChildMessageSchema,
});

export const smtpChildResponseSchema = z.union([
  z.object({ ok: z.literal(true), messageId: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type SmtpChildMessage = z.infer<typeof smtpChildMessageSchema>;
export type SmtpChildRequest = z.infer<typeof smtpChildRequestSchema>;
export type SmtpChildResponse = z.infer<typeof smtpChildResponseSchema>;

/** The child was started but no request reached it; it exits rather than linger. */
export const EXIT_NO_REQUEST = 20;
/** The request was unreadable. Nothing was sent, so this is a definite failure. */
export const EXIT_BAD_REQUEST = 21;
/** How long the child waits to be told what to send before giving up. */
export const CHILD_REQUEST_WAIT_MS = 30_000;
