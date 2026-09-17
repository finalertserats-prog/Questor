import { describe, it, expect, vi } from 'vitest';
import { createShutdown, type ActiveWork, type ShutdownDeps } from '../src/services/shutdown.js';

/**
 * The drain that stands between `pm2 restart` and a candidate mid-answer.
 *
 * Every restart used to kill the process on the spot: whoever was being
 * interviewed lost the request in flight and saw the room fail. The controller
 * is exercised here with an injected clock, sleep and exit, so the real test
 * process is never the one being shut down.
 */

const IDLE: ActiveWork = { sessions: 0, requests: 0, jobs: 0 };
const BUSY: ActiveWork = { sessions: 1, requests: 0, jobs: 0 };

function harness(overrides: Partial<ShutdownDeps> & { activity?: Array<ActiveWork | Error> } = {}) {
  let clock = 0;
  const events: string[] = [];
  const activity = overrides.activity ?? [IDLE];
  let polls = 0;
  const deps: ShutdownDeps = {
    drainMs: 60_000,
    pollMs: 1_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    countActive: async () => {
      const next = activity[Math.min(polls, activity.length - 1)];
      polls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    beginDrain: () => { events.push('drain'); },
    closeSteps: [
      { name: 'realtime', run: async () => { events.push('close:realtime'); } },
      { name: 'http', run: async () => { events.push('close:http'); } },
      { name: 'database', run: async () => { events.push('close:database'); } },
    ],
    exit: vi.fn((code: number) => { events.push(`exit:${code}`); }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, events, polls: () => polls, elapsed: () => clock };
}

describe('the shutdown drain', () => {
  it('stops taking new work before it waits for anything', async () => {
    const h = harness();

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.events[0]).toBe('drain');
  });

  it('closes realtime, then http, then the database, then exits cleanly once nothing is live', async () => {
    const h = harness({ activity: [BUSY, BUSY, IDLE] });

    await createShutdown(h.deps).handleSignal('SIGINT');

    expect(h.events).toEqual(['drain', 'close:realtime', 'close:http', 'close:database', 'exit:0']);
  });

  it('waits for the live interview to end rather than exiting on the first poll', async () => {
    const h = harness({ activity: [BUSY, BUSY, IDLE] });

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.polls()).toBe(3);
  });

  it('keeps waiting while a request or a background job is still running', async () => {
    const h = harness({ activity: [{ sessions: 0, requests: 1, jobs: 0 }, { sessions: 0, requests: 0, jobs: 1 }, IDLE] });

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.polls()).toBe(3);
  });

  it('gives up at the drain deadline and still exits cleanly', async () => {
    const h = harness({ activity: [BUSY] });

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.events.slice(-1)).toEqual(['exit:0']);
  });

  it('does not wait past the configured drain window', async () => {
    const h = harness({ activity: [BUSY] });

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.elapsed()).toBe(60_000);
  });

  it('says out loud that interviews were cut off at the deadline', async () => {
    const h = harness({ activity: [BUSY] });

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.deps.log.warn).toHaveBeenCalledWith(expect.objectContaining({ sessions: 1 }), expect.stringMatching(/drain window/i));
  });

  it('skips the wait entirely when the drain window is zero', async () => {
    const h = harness({ drainMs: 0, activity: [BUSY] });

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.polls()).toBe(0);
  });

  it('treats a failed activity check as busy and keeps waiting rather than guessing idle', async () => {
    const h = harness({ activity: [new Error('database down'), IDLE] });

    await createShutdown(h.deps).handleSignal('SIGTERM');

    expect(h.polls()).toBe(2);
  });

  it('runs the remaining close steps when one of them fails', async () => {
    const h = harness();
    const steps = [
      { name: 'realtime', run: async () => { throw new Error('boom'); } },
      ...h.deps.closeSteps.slice(1),
    ];

    await createShutdown({ ...h.deps, closeSteps: steps }).handleSignal('SIGTERM');

    expect(h.events).toEqual(['drain', 'close:http', 'close:database', 'exit:0']);
  });

  it('exits immediately on a second signal while draining', async () => {
    let release: () => void = () => undefined;
    const h = harness({ activity: [BUSY], sleep: () => new Promise<void>((resolve) => { release = resolve; }) });
    const shutdown = createShutdown(h.deps);

    const first = shutdown.handleSignal('SIGTERM');
    await vi.waitFor(() => expect(h.polls()).toBe(1));
    await shutdown.handleSignal('SIGINT');

    expect(h.deps.exit).toHaveBeenCalledWith(1);
    release();
    await first;
  });

  it('does not close or exit a second time after a forced exit', async () => {
    let release: () => void = () => undefined;
    const h = harness({ activity: [BUSY], sleep: () => new Promise<void>((resolve) => { release = resolve; }) });
    const shutdown = createShutdown(h.deps);

    const first = shutdown.handleSignal('SIGTERM');
    await vi.waitFor(() => expect(h.polls()).toBe(1));
    await shutdown.handleSignal('SIGINT');
    release();
    await first;

    expect(h.events).toEqual(['drain', 'exit:1']);
  });

  it('reports its phase so the process can tell draining from running', async () => {
    const h = harness();
    const shutdown = createShutdown(h.deps);
    expect(shutdown.phase()).toBe('running');

    await shutdown.handleSignal('SIGTERM');

    expect(shutdown.phase()).toBe('closed');
  });
});
