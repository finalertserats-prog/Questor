import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  _setSmtpSenderScriptForTest, inFlightSmtpSenders, killInFlightSmtpSenders, sendViaSmtpChild,
} from '../src/providers/email/smtpChild.js';
import { SendTimeoutError, smtpTransportOptions } from '../src/providers/email/timing.js';

/**
 * SMTP cannot be aborted and its socket timeout only measures silence: a
 * relay that answers just slowly enough can keep a send alive past any
 * deadline. So the send runs in its own process, and at the deadline that
 * process is killed outright. The operating system closes the socket, and a
 * message whose DATA was never terminated cannot be accepted.
 */

const MAIL = { from: 'hiring@questor.test', to: 'candidate@example.test', subject: 'Hello', text: 'Hi there', html: '<p>Hi there</p>' };

const CRASHING_SENDER = fileURLToPath(new URL('./fixtures/crashingSmtpSender.mjs', import.meta.url));

interface FakeSmtp {
  readonly port: number;
  readonly sawDataTerminator: () => boolean;
  readonly closedByClient: () => boolean;
  readonly close: () => Promise<void>;
}

/** Just enough SMTP to accept one message without TLS, and to remember what it saw. */
async function fastServer(): Promise<FakeSmtp> {
  let terminator = false;
  let closed = false;
  const server: Server = createServer((socket: Socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 fake.test ESMTP\r\n');
    socket.on('close', () => { closed = true; });
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (inData) {
        if (buffer.includes('\r\n.\r\n')) {
          terminator = true;
          inData = false;
          buffer = '';
          socket.write('250 OK queued as fake-1\r\n');
        }
        return;
      }
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') socket.write('235 ok\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 ok\r\n');
        else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
        index = buffer.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    sawDataTerminator: () => terminator,
    closedByClient: () => closed,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Greets, then answers every command one byte at a time, slowly, for ever: never silent, never done. */
async function tricklingServer(): Promise<FakeSmtp> {
  let terminator = false;
  let closed = false;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const server: Server = createServer((socket: Socket) => {
    socket.write('220 fake.test ESMTP\r\n');
    socket.on('error', () => undefined);
    socket.on('close', () => { closed = true; });
    socket.on('data', (chunk) => { if (chunk.toString('utf8').includes('\r\n.\r\n')) terminator = true; });
    // A response that never completes, one byte at a time, so no socket
    // timeout ever fires.
    const timer = setInterval(() => { if (!socket.destroyed) socket.write('2'); }, 300);
    timers.push(timer);
    socket.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    sawDataTerminator: () => terminator,
    closedByClient: () => closed,
    close: () => new Promise<void>((resolve) => { for (const t of timers) clearInterval(t); server.close(() => resolve()); }),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function optionsFor(port: number) {
  // ignoreTLS: the fake servers speak plain SMTP; the real transport upgrades
  // to STARTTLS when a server offers it, which these do not.
  return { ...smtpTransportOptions({ host: '127.0.0.1', port, user: 'u', pass: 'p' }), ignoreTLS: true };
}

let servers: FakeSmtp[] = [];

afterEach(async () => {
  _setSmtpSenderScriptForTest(null);
  await killInFlightSmtpSenders();
  for (const s of servers) await s.close();
  servers = [];
});

describe('sending through the child process', () => {
  it('delivers to a server that answers promptly, and reports the id it was given', async () => {
    const server = await fastServer();
    servers.push(server);

    const result = await sendViaSmtpChild({ transport: optionsFor(server.port), mail: MAIL, deadlineMs: 15_000 });

    expect({ terminator: server.sawDataTerminator(), id: typeof result.messageId }).toEqual({ terminator: true, id: 'string' });
  }, 30_000);

  it('leaves no child behind once the send is done', async () => {
    const server = await fastServer();
    servers.push(server);
    await sendViaSmtpChild({ transport: optionsFor(server.port), mail: MAIL, deadlineMs: 15_000 });
    expect(inFlightSmtpSenders()).toBe(0);
  }, 30_000);
});

describe('a server that trickles, never silent and never done', () => {
  it('is cut off at the deadline with a timeout, not waited on', async () => {
    const server = await tricklingServer();
    servers.push(server);
    const startedAt = Date.now();

    await expect(sendViaSmtpChild({ transport: optionsFor(server.port), mail: MAIL, deadlineMs: 4_000 })).rejects.toBeInstanceOf(SendTimeoutError);

    expect(Date.now() - startedAt).toBeLessThan(4_000 + 3_000);
  }, 30_000);

  it('kills the child outright, so no process is left holding the socket', async () => {
    const server = await tricklingServer();
    servers.push(server);
    let pid = 0;

    await sendViaSmtpChild({ transport: optionsFor(server.port), mail: MAIL, deadlineMs: 4_000, onStarted: (childPid) => { pid = childPid; } })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect({ pid: pid > 0, alive: pidAlive(pid), inFlight: inFlightSmtpSenders() }).toEqual({ pid: true, alive: false, inFlight: 0 });
  }, 30_000);

  it('never sent the end of the message, so the server cannot have accepted it', async () => {
    const server = await tricklingServer();
    servers.push(server);

    await sendViaSmtpChild({ transport: optionsFor(server.port), mail: MAIL, deadlineMs: 4_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect({ terminator: server.sawDataTerminator(), closed: server.closedByClient() }).toEqual({ terminator: false, closed: true });
  }, 30_000);
});

describe('a child that cannot do the job', () => {
  it('is a definite failure when it crashes, not a timeout', async () => {
    _setSmtpSenderScriptForTest(CRASHING_SENDER);
    const server = await fastServer();
    servers.push(server);

    const outcome = await sendViaSmtpChild({ transport: optionsFor(server.port), mail: MAIL, deadlineMs: 15_000 })
      .then(() => 'sent', (err: unknown) => (err instanceof SendTimeoutError ? 'timeout' : 'failed'));

    expect(outcome).toBe('failed');
  }, 30_000);

  it('is a definite failure when it cannot even be started', async () => {
    _setSmtpSenderScriptForTest('D:/definitely/not/here/smtpSender.mjs');

    const outcome = await sendViaSmtpChild({ transport: optionsFor(1), mail: MAIL, deadlineMs: 15_000 })
      .then(() => 'sent', (err: unknown) => (err instanceof SendTimeoutError ? 'timeout' : 'failed'));

    expect({ outcome, inFlight: inFlightSmtpSenders() }).toEqual({ outcome: 'failed', inFlight: 0 });
  }, 30_000);
});

describe('at shutdown', () => {
  it('kills whatever is still in flight', async () => {
    const server = await tricklingServer();
    servers.push(server);
    let pid = 0;
    const pending = sendViaSmtpChild({ transport: optionsFor(server.port), mail: MAIL, deadlineMs: 60_000, onStarted: (p) => { pid = p; } })
      .catch(() => 'stopped');
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    await killInFlightSmtpSenders();
    const outcome = await pending;
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect({ outcome, alive: pid > 0 && pidAlive(pid), inFlight: inFlightSmtpSenders() }).toEqual({ outcome: 'stopped', alive: false, inFlight: 0 });
  }, 30_000);
});
