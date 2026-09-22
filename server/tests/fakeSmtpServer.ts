import { createServer, type Server, type Socket } from 'node:net';

/**
 * Two mail servers made of a TCP socket and a switch statement: one that
 * accepts a message properly, and one that answers the greeting and then
 * merely stays busy.
 *
 * The busy one is the whole point. nodemailer's socketTimeout is an INACTIVITY
 * timeout, not a budget: a server that keeps dribbling bytes is never idle, so
 * no transport timeout ever fires and a send can run for as long as the server
 * likes. That is the case the hard kill exists for, and it cannot be written
 * with a mock — only a real socket behaves this way.
 */

/** The end of an SMTP message body. A server that never saw it cannot have accepted the mail. */
const DATA_TERMINATOR = '\r\n.\r\n';

export interface FakeSmtpServer {
  readonly port: number;
  /** True once a client finished a message body; false means nothing could have been accepted. */
  sawDataTerminator(): boolean;
  /** Resolves once a client has connected, so a test can act mid-conversation. */
  whenConnected(): Promise<void>;
  /** Resolves once a client connection has closed, however it closed. */
  whenClosed(): Promise<void>;
  close(): Promise<void>;
}

interface Listening {
  readonly server: Server;
  readonly port: number;
}

async function listen(onConnection: (socket: Socket) => void): Promise<Listening> {
  const server = createServer(onConnection);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

function closer(server: Server): () => Promise<void> {
  return () => new Promise<void>((resolve) => { server.close(() => resolve()); });
}

/**
 * Answers the greeting and then writes one byte at a time, for ever, never
 * completing a response line. The client has nothing to act on and nothing to
 * time out on: the connection is busy, not idle.
 *
 * The real thing is a relay answering each command just inside the socket
 * timeout; a byte every few hundred milliseconds is the same shape at test
 * speed, and it leaves the transport's own 15s phase timeouts untouched so a
 * send that ends can only have been ended by the kill.
 */
export async function startTricklingSmtpServer(opts: { byteEveryMs?: number } = {}): Promise<FakeSmtpServer> {
  let received = '';
  let closeClient: () => void = () => {};
  let connectClient: () => void = () => {};
  const closed = new Promise<void>((resolve) => { closeClient = resolve; });
  const connected = new Promise<void>((resolve) => { connectClient = resolve; });

  const { server, port } = await listen((socket) => {
    connectClient();
    socket.write('220 trickle.test ESMTP\r\n');
    const timer = setInterval(() => { socket.write('x'); }, opts.byteEveryMs ?? 200);
    socket.on('data', (chunk: Buffer) => { received += chunk.toString('utf8'); });
    socket.on('error', () => undefined);
    socket.on('close', () => { clearInterval(timer); closeClient(); });
  });

  return {
    port,
    sawDataTerminator: () => received.includes(DATA_TERMINATOR),
    whenConnected: () => connected,
    whenClosed: () => closed,
    close: closer(server),
  };
}

/** A mail server that behaves: greeting, EHLO, AUTH, envelope, body, 250. */
export async function startFastSmtpServer(): Promise<FakeSmtpServer> {
  let sawTerminator = false;
  let closeClient: () => void = () => {};
  let connectClient: () => void = () => {};
  const closed = new Promise<void>((resolve) => { closeClient = resolve; });
  const connected = new Promise<void>((resolve) => { connectClient = resolve; });

  const { server, port } = await listen((socket) => {
    let buffer = '';
    let inBody = false;
    connectClient();
    socket.write('220 fast.test ESMTP\r\n');

    // Re-entered after the body ends, because a chunk can carry both the end
    // of the message and the QUIT that follows it.
    const consume = (): void => {
      if (inBody) {
        if (!buffer.includes(DATA_TERMINATOR)) return;
        sawTerminator = true;
        inBody = false;
        buffer = buffer.slice(buffer.indexOf(DATA_TERMINATOR) + DATA_TERMINATOR.length);
        socket.write('250 2.0.0 Ok: queued as FAKE1\r\n');
        consume();
        return;
      }
      let end = buffer.indexOf('\r\n');
      while (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') {
          socket.write('250-fast.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (command === 'AUTH') {
          socket.write('235 2.7.0 Accepted\r\n');
        } else if (command === 'DATA') {
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          inBody = true;
          consume();
          return;
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
          return;
        } else {
          socket.write('250 2.1.0 Ok\r\n');
        }
        end = buffer.indexOf('\r\n');
      }
    };

    socket.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8'); consume(); });
    socket.on('error', () => undefined);
    socket.on('close', () => closeClient());
  });

  return {
    port,
    sawDataTerminator: () => sawTerminator,
    whenConnected: () => connected,
    whenClosed: () => closed,
    close: closer(server),
  };
}
