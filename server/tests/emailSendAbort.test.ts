import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a mail provider can be told to stop, it is. A timed-out send is a
 * message we can no longer account for; the least we can do is stop the
 * request we still hold the handle to.
 */

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, email: { ...actual.config.email, provider: 'sendgrid', sendgridKey: 'test-key', from: 'hiring@questor.test' } } };
});

const { getEmail, _resetEmail } = await import('../src/providers/email/index.js');

const MESSAGE = { to: 'candidate@example.test', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' };

interface CapturedFetch {
  readonly signal: AbortSignal | null | undefined;
}

let captured: CapturedFetch | null = null;
const realFetch = globalThis.fetch;

beforeEach(() => {
  _resetEmail();
  captured = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A fetch that hangs until its signal aborts, as a stalled provider would. */
function stalledFetch(): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) => {
    captured = { signal: init?.signal };
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })));
    });
  }) as typeof fetch;
}

describe('the SendGrid provider', () => {
  it('hands the abort signal it is given to the request', async () => {
    globalThis.fetch = stalledFetch();
    const controller = new AbortController();
    const pending = getEmail().send(MESSAGE, { signal: controller.signal }).catch(() => 'aborted');
    controller.abort();
    await pending;
    expect(captured?.signal).toBe(controller.signal);
  });

  it('stops the request when the signal aborts', async () => {
    globalThis.fetch = stalledFetch();
    const controller = new AbortController();
    const pending = getEmail().send(MESSAGE, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('still sends when no signal is given', async () => {
    globalThis.fetch = (async () => new Response('', { status: 202, headers: { 'x-message-id': 'm1' } })) as typeof fetch;
    expect(await getEmail().send(MESSAGE)).toEqual({ status: 'sent', id: 'm1' });
  });
});
