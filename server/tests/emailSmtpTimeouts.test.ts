import { createServer, type Server } from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import { EMAIL_SEND_TIMEOUT_MS, SMTP_TIMEOUTS, smtpMaxLifetimeMs, smtpTransportOptions } from '../src/providers/email/timing.js';
import { FEEDBACK_SEND_TIMEOUT_MS, SEND_LOCK_GRACE_MS } from '../src/services/autoFeedback.js';

/**
 * SMTP cannot be aborted, so the transport's own timeouts are what bound a
 * send. Every phase is derived from one constant, and the feedback send lock
 * is proved to outlive the longest a sendMail can possibly run — so a message
 * can never be delivered after a review has been allowed through.
 */

describe('the SMTP transport timeouts', () => {
  it('are all derived from the one send timeout', () => {
    const phases = [SMTP_TIMEOUTS.dnsTimeout, SMTP_TIMEOUTS.connectionTimeout, SMTP_TIMEOUTS.greetingTimeout, SMTP_TIMEOUTS.socketTimeout];
    expect(phases.every((ms) => ms > 0 && ms <= EMAIL_SEND_TIMEOUT_MS)).toBe(true);
  });

  it('add up to no more than the send timeout, so sendMail rejects by then', () => {
    expect(smtpMaxLifetimeMs()).toBeLessThanOrEqual(EMAIL_SEND_TIMEOUT_MS);
  });

  it('are what the transport is created with', () => {
    const options = smtpTransportOptions({ host: 'mail.example.test', port: 587, user: 'u', pass: 'p' });
    expect(options).toMatchObject({ host: 'mail.example.test', port: 587, secure: false, ...SMTP_TIMEOUTS });
  });

  it('use implicit TLS on 465 and STARTTLS otherwise', () => {
    expect([
      smtpTransportOptions({ host: 'h', port: 465, user: 'u', pass: 'p' }).secure,
      smtpTransportOptions({ host: 'h', port: 587, user: 'u', pass: 'p' }).secure,
    ]).toEqual([true, false]);
  });
});

describe('the feedback send lock against the transport', () => {
  it('uses the same send timeout as the transport', () => {
    expect(FEEDBACK_SEND_TIMEOUT_MS).toBe(EMAIL_SEND_TIMEOUT_MS);
  });

  it('expires strictly after the longest a send can run', () => {
    expect(FEEDBACK_SEND_TIMEOUT_MS + SEND_LOCK_GRACE_MS).toBeGreaterThan(smtpMaxLifetimeMs());
  });
});

describe('a mail server that never answers', () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => { server?.close(() => resolve()); });
    server = null;
  });

  /** Accepts the connection and then says nothing, as a hung relay does. */
  async function silentServer(): Promise<number> {
    server = createServer((socket) => { socket.on('error', () => undefined); });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
    const address = server?.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  it('is given up on within the transport timeouts rather than waited on for ever', async () => {
    const port = await silentServer();
    // The same options the provider uses, with the one constant shrunk so
    // the test runs in under a second; nodemailer is what enforces them.
    const options = smtpTransportOptions({ host: '127.0.0.1', port, user: 'u', pass: 'p' }, 400);
    const transport = nodemailer.createTransport({ ...options, tls: { rejectUnauthorized: false } });
    const startedAt = Date.now();

    await expect(transport.sendMail({ from: 'a@b.test', to: 'c@d.test', subject: 's', text: 't' })).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(400 + 1000);
  }, 10_000);
});
