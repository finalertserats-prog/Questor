import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { releaseHeldLeases, stopAllJobs } from '../services/jobs.js';
import { defaultWorkerDeps, runWorkerUnderLease } from './worker.js';

/**
 * The library worker as its own process: `npm run library:worker` locally,
 * `node dist/library/workerMain.js` under pm2 as `questor-library` in
 * production. It exits at once, with one log line, unless
 * LIBRARY_WORKER_ENABLED=true, so the process can be in the pm2 list on
 * every deployment and still do nothing until the owner switches it on.
 */

if (!config.library.workerEnabled) {
  logger.info('LIBRARY_WORKER_ENABLED is not true; the library worker is not running.');
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

let stopping = false;
let wake: (() => void) | null = null;

/** Sleeps that end early on SIGTERM, so a pause of an hour never delays a deploy. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });
}

function requestStop(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'Library worker stopping after the batch in flight');
  stopAllJobs();
  wake?.();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => requestStop(signal));
process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'Unhandled rejection in library worker'));

const deps = defaultWorkerDeps({ sleep });
logger.info({ concurrency: deps.concurrency, dailyCap: deps.caps.dailyCap, critic: config.library.criticProvider, libraryEnabled: config.library.enabled }, 'Library worker starting');
if (!config.library.enabled) logger.warn('LIBRARY_ENABLED is false: the worker fills the library in the dark; nothing it writes reaches an organisation until the switch is on.');

try {
  const run = await runWorkerUnderLease(deps, { stopped: () => stopping });
  logger.info({ outcome: run.outcome, exit: run.exit }, 'Library worker finished');
} catch (err) {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Library worker crashed');
  process.exitCode = 1;
} finally {
  await releaseHeldLeases().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
}
