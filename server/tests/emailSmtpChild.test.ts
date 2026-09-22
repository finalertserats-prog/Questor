import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EmailSendTimeoutError, smtpTransportOptions } from '../src/providers/email/timing.js';
import { killInFlightSmtpSends, sendSmtpInChild } from '../src/providers/email/smtpSend.js';
import { startFastSmtpServer, startTricklingSmtpServer, type FakeSmtpServer } from './fakeSmtpServer.js';

/**
 * The SMTP send runs in a child process so that the deadline can be enforced
 * by killing it. nodemailer cannot be aborted and its socketTimeout only
 * bounds silence, so without the kill a slow-but-talkative relay could accept
 * a candidate's letter after the send lock had expired and a reviewer had
 * already corrected it. SIGKILL closes the socket mid-conversation, and a
 * message whose body was never terminated cannot be accepted by anyone.
 */

const MESSAGE = {
  from: 'Questor <no-reply@questor.test>',
  to: 'priya@candidate.test',
  subject: 'Your interview feedback',
  text: 'Hi Priya,',
  html: '<p>Hi Priya,</p>',
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A stand-in sender that dies the moment it starts, for the crash case. */
function scriptThatExits(code: number): string {
  const path = join(mkdtempSync(join(tmpdir(), 'questor-smtp-child-')), 'exit.mjs');
  writeFileSync(path, `process.stderr.write('sender exploded\\n');\nprocess.exit(${code});\n`, 'utf8');
  return path;
}

describe('the SMTP send in a child process', () => {
  let mailServer: FakeSmtpServer | null = null;

  afterEach(async () => {
    await mailServer?.close();
    mailServer = null;
  });

  function transportFor(port: number) {
    // The real per-phase timeouts, deliberately: 15s each, so nothing the
    // transport does can end these tests. Only the kill can.
    return smtpTransportOptions({ host: '127.0.0.1', port, user: 'u', pass: 'p' });
  }

  it('kills the child at the deadline, and the mail server never sees a finished message', async () => {
    mailServer = await startTricklingSmtpServer({ byteEveryMs: 150 });
    let pid = 0;
    const startedAt = Date.now();

    // Generous, because the deadline covers starting the child too and a
    // loaded machine is slow to boot one: the conversation has to be under way
    // before the deadline, or this proves nothing about killing one.
    const sending = sendSmtpInChild(transportFor(mailServer.port), MESSAGE, {
      deadlineMs: 10_000,
      onSpawn: (spawned) => { pid = spawned; },
    }).catch((err: unknown) => err);
    await mailServer.whenConnected();
    const outcome = await sending;
    await mailServer.whenClosed();

    expect({
      timedOut: outcome instanceof EmailSendTimeoutError,
      childAlive: isAlive(pid),
      accepted: mailServer.sawDataTerminator(),
      endedAtTheDeadline: Date.now() - startedAt < 25_000,
    }).toEqual({ timedOut: true, childAlive: false, accepted: false, endedAtTheDeadline: true });
  }, 60_000);

  it('sends through the child and brings the message id back when the server answers', async () => {
    mailServer = await startFastSmtpServer();

    const result = await sendSmtpInChild(transportFor(mailServer.port), MESSAGE, { deadlineMs: 20_000 });

    expect({ id: result.messageId.length > 0, accepted: mailServer.sawDataTerminator() })
      .toEqual({ id: true, accepted: true });
  }, 30_000);

  /**
   * A forked child outlives its parent, so a stopping process would otherwise
   * leave an SMTP conversation running with nobody left to record its outcome.
   * Being killed by us is not a crash: the message may have been accepted
   * before the socket closed, so it is the same unknown outcome as the
   * deadline — recorded, never retried.
   */
  it('kills a send still in flight when the process shuts down, and calls the outcome unknown', async () => {
    mailServer = await startTricklingSmtpServer({ byteEveryMs: 150 });
    let pid = 0;
    const sending = sendSmtpInChild(transportFor(mailServer.port), MESSAGE, {
      deadlineMs: 60_000,
      onSpawn: (spawned) => { pid = spawned; },
    }).catch((err: unknown) => err);
    await mailServer.whenConnected();

    const killed = killInFlightSmtpSends();
    const outcome = await sending;
    await mailServer.whenClosed();

    expect({
      killed,
      unknown: outcome instanceof EmailSendTimeoutError,
      childAlive: isAlive(pid),
      accepted: mailServer.sawDataTerminator(),
    }).toEqual({ killed: 1, unknown: true, childAlive: false, accepted: false });
  }, 30_000);

  it('is a definite failure, not a timeout, when the child dies on startup', async () => {
    mailServer = await startFastSmtpServer();

    const outcome = await sendSmtpInChild(transportFor(mailServer.port), MESSAGE, {
      deadlineMs: 20_000,
      script: scriptThatExits(3),
    }).catch((err: unknown) => err);

    expect({
      definite: outcome instanceof Error && !(outcome instanceof EmailSendTimeoutError),
      says: outcome instanceof Error ? /exit(ed)?.*3|code 3/i.test(outcome.message) : false,
    }).toEqual({ definite: true, says: true });
  }, 30_000);
});
