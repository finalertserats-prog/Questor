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
import { startImportPurge } from './services/candidateImportPurgeJob.js';
import { startIncompleteSweep } from './services/incompleteInterviews.js';
import { startWebhookDelivery } from './services/webhooks.js';
import { rescheduleLegacyFeedbackEmails, startFeedbackEmailDelivery } from './services/autoFeedback.js';
import { killInFlightSmtpSenders } from './providers/email/smtpChild.js';
import { backfillInvitationSecrets } from './services/invitations.js';
import { seedCatalogWithRetry } from './services/catalogSeed.js';
import { initInterviewers } from './services/interviewers.js';
import { startRateLimitPurge } from './middleware/rateLimit.js';
import { releaseHeldLeases, runningJobCount, startJob, stopAllJobs } from './services/jobs.js';
import { JD_DRAFT_JOB, runJdDraftJob } from './services/jdDrafts.js';
import { startCatalogRefreshSchedule } from './services/catalogRefresh.js';
import { startInvitationReminders } from './services/invitationReminders.js';
import { startDailyDigest } from './services/dailyDigest.js';
import { startOutcomeSnapshots } from './services/outcomeSnapshot.js';
import { startCalibrationJob } from './services/calibrationJob.js';
import { reportMissingOperatorAccounts } from './middleware/platformOperator.js';
import { markDraining } from './services/drainState.js';
import { countLiveSessions, inFlightRequests } from './realtime/liveSessions.js';
import { createShutdown } from './services/shutdown.js';

preflight();
startRetentionSweep();
startDemoPurge();
// Bulk imports nobody confirmed or discarded: names, addresses and CV text of
// people who were never added.
startImportPurge();
// Interviews that stopped part-way would otherwise stay ASSESSING for ever,
// showing as "in progress" and never producing anything to read. Marks them
// INCOMPLETE and saves the transcript; deliberately never scores them.
startIncompleteSweep();
// Deliveries are rows with a due time; this job sends whatever is due, on
// whichever instance holds the lease, so nothing is lost to a restart.
startWebhookDelivery();
// Candidates' feedback emails, queued when an assessment is stored. The same
// row-with-a-due-time pattern, so a restart never loses or repeats one.
// Letters queued before the review window existed would otherwise all go on
// the first tick. Awaited before the job starts, so none slip through first.
await rescheduleLegacyFeedbackEmails().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not reschedule feedback emails queued before the review window');
});
startFeedbackEmailDelivery();
// Ended rate-limit windows, when counters are shared through the database.
startRateLimitPurge();
startJob({ name: JD_DRAFT_JOB.name, intervalMs: JD_DRAFT_JOB.intervalMs, ttlMs: JD_DRAFT_JOB.ttlMs, fn: runJdDraftJob });
startCatalogRefreshSchedule();
// HR-Box emails, each behind its own switch (both off by default): candidate
// reminders and the recruiter's expiry warning, and the daily summary.
startInvitationReminders();
startDailyDigest();
// Monthly outcome aggregates (OUTCOME_SNAPSHOT_ENABLED, off by default), so a
// trend survives the candidate data it was computed from being erased.
startOutcomeSnapshots();
startCalibrationJob();
reportMissingOperatorAccounts().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not check platform operator accounts');
});
// One-time move of invitation tokens out of plaintext; a no-op once done.
backfillInvitationSecrets().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not backfill invitation token storage');
});
// Seeded before the server listens, so the first New role form after a deploy
// never sees an empty or half-filled catalog. If that first try fails the
// server still starts, and the seed keeps retrying in the background.
if (!(await seedCatalogWithRetry({ maxAttempts: 1 }))) void seedCatalogWithRetry();
// The five AI interviewers and their voices, the VOICE_PROFILE_0N overrides,
// and a real interviewer for any not-yet-started session from before them.
// A failure is logged, not fatal: interview creation seeds on demand too.
await initInterviewers().catch((err: unknown) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Could not initialise AI interviewers');
});

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
    // Sender processes still running are killed, not waited for: a message
    // cut off mid-conversation is never accepted, and a review can be
    // released once the lock expires.
    { name: 'smtp-senders', run: () => killInFlightSmtpSenders() },
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
