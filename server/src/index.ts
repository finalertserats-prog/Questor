import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachInterviewSocket } from './realtime/socket.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { prisma } from './db.js';
import { getLlm } from './providers/llm/index.js';
import { preflight } from './preflight.js';

import { startRetentionSweep } from './services/dataRights.js';
import { startDemoPurge } from './services/demoPurgeJob.js';
import { startIncompleteSweep } from './services/incompleteInterviews.js';
import { startWebhookDelivery } from './services/webhooks.js';
import { backfillInvitationSecrets } from './services/invitations.js';
import { seedCatalogWithRetry } from './services/catalogSeed.js';
import { startRateLimitPurge } from './middleware/rateLimit.js';
import { releaseHeldLeases, runningJobCount, startJob, stopAllJobs } from './services/jobs.js';
import { generatePendingDrafts, JD_DRAFT_JOB } from './services/jdDrafts.js';
import { markDraining } from './services/drainState.js';
import { countLiveSessions, inFlightRequests } from './realtime/liveSessions.js';
import { createShutdown } from './services/shutdown.js';

preflight();
startRetentionSweep();
startDemoPurge();
// Interviews that stopped part-way would otherwise stay ASSESSING for ever,
// showing as "in progress" and never producing anything to read. Marks them
// INCOMPLETE and saves the transcript; deliberately never scores them.
startIncompleteSweep();
// Deliveries are rows with a due time; this job sends whatever is due, on
// whichever instance holds the lease, so nothing is lost to a restart.
startWebhookDelivery();
// Ended rate-limit windows, when counters are shared through the database.
startRateLimitPurge();
startJob({ name: JD_DRAFT_JOB.name, intervalMs: 5_000, ttlMs: JD_DRAFT_JOB.ttlMs, fn: async () => `generated ${await generatePendingDrafts({ limit: JD_DRAFT_JOB.batch })} JD drafts` });
// One-time move of invitation tokens out of plaintext; a no-op once done.
backfillInvitationSecrets().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not backfill invitation token storage');
});
// Seeded before the server listens, so the first New role form after a deploy
// never sees an empty or half-filled catalog. If that first try fails the
// server still starts, and the seed keeps retrying in the background.
if (!(await seedCatalogWithRetry({ maxAttempts: 1 }))) void seedCatalogWithRetry();

const app = createApp();
const httpServer = createServer(app);
const io = attachInterviewSocket(httpServer);

httpServer.listen(config.port, config.bindHost, () => {
  const llm = getLlm();
  logger.info(`🎙️  Questor server listening on http://${config.bindHost}:${config.port}`);
  if (config.bindHost === '0.0.0.0' && config.nodeEnv === 'production') {
    logger.warn(
      'BIND_HOST=0.0.0.0 in production: the app port is reachable directly from the network, ' +
      'bypassing the reverse proxy and its TLS. Anything sent to it — including session cookies ' +
      'and interview transcripts — travels unencrypted. Bind to 127.0.0.1 unless nothing fronts this.',
    );
  }
  logger.info(`    LLM: ${llm.name}${llm.enabled ? ' (remote)' : ' (built-in heuristic — no key needed)'}  |  STT: ${config.stt.provider}  |  TTS: ${config.tts.provider}`);
  logger.info(`    Web origin: ${config.webOrigin}`);
  logger.info(`    Rate limits: ${config.rateLimitStore}  |  Shutdown drain: ${Math.round(config.shutdownDrainMs / 1000)}s`);
});

// Once the drain has waited, connections still open are ones nobody is using;
// this bounds how long a stuck keep-alive can hold the exit.
const HTTP_CLOSE_GRACE_MS = 10_000;
const DRAIN_POLL_MS = 5_000;

const shutdown = createShutdown({
  drainMs: config.shutdownDrainMs,
  pollMs: DRAIN_POLL_MS,
  countActive: async () => ({
    sessions: await countLiveSessions(),
    requests: inFlightRequests(),
    jobs: runningJobCount(),
  }),
  beginDrain: () => {
    markDraining();
    stopAllJobs();
  },
  closeSteps: [
    // io.close() disconnects every socket and then closes the HTTP server too.
    {
      name: 'realtime',
      run: () => new Promise<void>((resolve) => {
        io.close(() => resolve());
        setTimeout(() => httpServer.closeAllConnections(), HTTP_CLOSE_GRACE_MS).unref();
      }),
    },
    {
      name: 'http',
      run: () => new Promise<void>((resolve) => {
        if (!httpServer.listening) { resolve(); return; }
        httpServer.close(() => resolve());
        setTimeout(() => httpServer.closeAllConnections(), HTTP_CLOSE_GRACE_MS).unref();
      }),
    },
    { name: 'leases', run: () => releaseHeldLeases() },
    { name: 'database', run: () => prisma.$disconnect() },
  ],
  exit: (code) => process.exit(code),
  log: logger,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { void shutdown.handleSignal(signal); });
}

process.on('unhandledRejection', (reason) => logger.error({ reason: String(reason) }, 'Unhandled rejection'));
