/**
 * The shutdown drain: what happens between pm2's SIGINT/SIGTERM and exit.
 *
 * Every restart used to kill the process on the spot, so each deploy ended any
 * interview in progress mid-answer. Now the process stops taking new work,
 * waits (up to a limit) for the interviews it is serving to end, closes its
 * listeners in order and exits cleanly. A second signal means an operator wants
 * it gone now, and gets that.
 *
 * Everything with a side effect is injected — clock, sleep, the close steps and
 * exit itself — so the state machine is tested without ending the test run.
 */

export interface ActiveWork {
  /** Interviews this process is serving. */
  sessions: number;
  /** HTTP requests and socket events still running. */
  requests: number;
  /** Background jobs mid-run. */
  jobs: number;
}

export interface CloseStep {
  name: string;
  run: () => Promise<void>;
}

export interface ShutdownLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface ShutdownDeps {
  drainMs: number;
  pollMs: number;
  countActive: () => Promise<ActiveWork>;
  /** Stop accepting new work: mark draining, stop job timers. */
  beginDrain: () => void | Promise<void>;
  /** Run in order once the drain ends; a failing step does not stop the rest. */
  closeSteps: CloseStep[];
  exit: (code: number) => void;
  log: ShutdownLog;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type ShutdownPhase = 'running' | 'draining' | 'closing' | 'closed' | 'forced';

const isIdle = (w: ActiveWork) => w.sessions === 0 && w.requests === 0 && w.jobs === 0;

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createShutdown(deps: ShutdownDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref?.(); }));
  let phase: ShutdownPhase = 'running';
  // Read through a function so TypeScript does not narrow it across awaits; a
  // second signal changes it while the drain loop is suspended.
  const forced = () => phase === 'forced';

  /** Poll until nothing is live or the window closes; the last reading. */
  async function waitForIdle(): Promise<ActiveWork | null> {
    const deadline = now() + deps.drainMs;
    let last: ActiveWork | null = null;
    while (!forced()) {
      try {
        last = await deps.countActive();
        if (isIdle(last)) return last;
      } catch (err) {
        // Unknown is not idle: exiting on a failed check is exactly how a live
        // interview gets cut off.
        deps.log.warn({ err: describe(err) }, 'Could not count live work during drain; still waiting');
      }
      const remaining = deadline - now();
      if (remaining <= 0) return last;
      await sleep(Math.min(deps.pollMs, remaining));
    }
    return last;
  }

  async function drainThenExit(signal: string): Promise<void> {
    phase = 'draining';
    deps.log.info({ signal, drainMs: deps.drainMs }, 'Shutdown requested; draining — no new interviews will start here');
    try {
      await deps.beginDrain();
    } catch (err) {
      deps.log.error({ err: describe(err) }, 'Could not stop taking new work cleanly; draining anyway');
    }

    if (deps.drainMs > 0) {
      const last = await waitForIdle();
      if (forced()) return;
      if (last && !isIdle(last)) {
        deps.log.warn({ ...last, drainMs: deps.drainMs },
          'Drain window ended with work still live; those interviews are cut off and resume after restart');
      }
    }

    phase = 'closing';
    for (const step of deps.closeSteps) {
      if (forced()) return;
      try {
        await step.run();
      } catch (err) {
        deps.log.error({ step: step.name, err: describe(err) }, 'Shutdown step failed; continuing');
      }
    }
    if (forced()) return;
    phase = 'closed';
    deps.log.info({ signal }, 'Shutdown complete');
    deps.exit(0);
  }

  return {
    phase: (): ShutdownPhase => phase,
    async handleSignal(signal: string): Promise<void> {
      if (phase === 'running') return drainThenExit(signal);
      if (phase === 'forced' || phase === 'closed') return;
      phase = 'forced';
      deps.log.warn({ signal }, 'Second shutdown signal; exiting now without waiting');
      deps.exit(1);
    },
  };
}
