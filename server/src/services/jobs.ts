import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';

/**
 * Background work that must happen exactly once per interval, whichever
 * instance is running, and whose failures must be visible.
 *
 * Every sweep used to be a bare setInterval: two instances would have swept
 * twice, a crash mid-run lost nothing but also told nobody, and a job that had
 * failed on every tick for a month looked identical in the logs to one with
 * nothing to do. A job now takes a database lease before it runs, records each
 * run, and alerts the operator when a run fails.
 */

/** This process, for the lease holder column and the operations view. */
export const INSTANCE_ID = `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;

export type JobOutcome = 'ran' | 'skipped' | 'failed';

/**
 * Run `fn` if this instance can take the lease for `name`; otherwise skip.
 * Records a JobRun either way it runs. Never throws: a job's failure is logged,
 * recorded and alerted, and the caller's interval keeps ticking.
 */
export async function runExclusive(name: string, ttlMs: number, fn: () => Promise<string | void>): Promise<JobOutcome> {
  // A process that is shutting down must not start work it may not finish;
  // the next instance will take the lease on its own first tick.
  if (stopped) return 'skipped';
  running += 1;
  try {
    return await runUnderLease(name, ttlMs, fn);
  } finally {
    running -= 1;
  }
}

async function runUnderLease(name: string, ttlMs: number, fn: () => Promise<string | void>): Promise<JobOutcome> {
  const held = await acquireLease(name, ttlMs);
  if (!held) return 'skipped';

  const run = await prisma.jobRun.create({ data: { name, holder: INSTANCE_ID } });
  try {
    const note = (await fn()) ?? '';
    await prisma.jobRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: true, note: note.slice(0, 500) } });
    return 'ran';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.jobRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: false, note: message.slice(0, 500) } })
      .catch(() => undefined);
    logger.error({ job: name, err: message }, 'Background job failed');
    await alertOperator(name, message);
    return 'failed';
  } finally {
    await releaseLease(name);
  }
}

/**
 * Keep running `fn` every `intervalMs` under the lease. The first tick is
 * immediate unless `delayFirst`. Returns a stop function.
 */
export function startJob(opts: {
  name: string;
  intervalMs: number;
  ttlMs?: number;
  delayFirst?: boolean;
  fn: () => Promise<string | void>;
}): () => void {
  const ttlMs = opts.ttlMs ?? Math.max(opts.intervalMs, 60_000);
  const tick = () => {
    runExclusive(opts.name, ttlMs, opts.fn).catch((err: unknown) => {
      // runExclusive swallows the job's own errors; this is for the lease and
      // bookkeeping themselves (the database being down, say).
      logger.error({ job: opts.name, err: err instanceof Error ? err.message : String(err) }, 'Background job could not be scheduled');
    });
  };
  if (!opts.delayFirst) tick();
  const timer = setInterval(tick, opts.intervalMs);
  timer.unref?.();
  timers.add(timer);
  return () => {
    clearInterval(timer);
    timers.delete(timer);
  };
}

// Shutdown bookkeeping. `stopped` is one-way: a draining process never resumes
// scheduling work.
const timers = new Set<ReturnType<typeof setInterval>>();
let stopped = false;
let running = 0;

/** Stop every job's timer and refuse further runs in this process. */
export function stopAllJobs(): void {
  stopped = true;
  for (const timer of timers) clearInterval(timer);
  timers.clear();
}

/** Job runs still in progress, which a drain waits for. */
export function runningJobCount(): number {
  return running;
}

/**
 * Hand back every lease this instance holds, as the last step before exit, so
 * the next instance can run the job at once instead of waiting out the TTL.
 * Scoped to this holder: another instance's lease is never touched.
 */
export async function releaseHeldLeases(): Promise<void> {
  await prisma.jobLease.updateMany({ where: { holder: INSTANCE_ID }, data: { expiresAt: new Date(0) } });
}

/** Test hook: undo stopAllJobs and forget running counts. */
export function _resetJobsForTest(): void {
  stopAllJobs();
  stopped = false;
  running = 0;
}

async function acquireLease(name: string, ttlMs: number): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  // Take an expired lease with a conditional update; only one caller's update
  // can match the old expiry, so only one wins.
  const taken = await prisma.jobLease.updateMany({
    where: { name, expiresAt: { lt: now } },
    data: { holder: INSTANCE_ID, expiresAt },
  });
  if (taken.count === 1) return true;
  const existing = await prisma.jobLease.findUnique({ where: { name } });
  if (existing) return false;
  try {
    await prisma.jobLease.create({ data: { name, holder: INSTANCE_ID, expiresAt } });
    return true;
  } catch {
    // Someone else created it between the lookup and the insert.
    return false;
  }
}

async function releaseLease(name: string): Promise<void> {
  // Only the holder releases; a lease that expired and was taken by another
  // instance mid-run must not be released by the slow one finishing late.
  await prisma.jobLease.updateMany({ where: { name, holder: INSTANCE_ID }, data: { expiresAt: new Date(0) } }).catch(() => undefined);
}

// One alert per job per hour. A job failing every five minutes is one problem,
// not twelve emails an hour.
const ALERT_WINDOW_MS = 60 * 60_000;
const lastAlertAt = new Map<string, number>();

async function alertOperator(job: string, message: string): Promise<void> {
  const to = config.signupApproverEmail.trim();
  if (!to) return;
  const now = Date.now();
  const last = lastAlertAt.get(job) ?? 0;
  if (now - last < ALERT_WINDOW_MS) return;
  lastAlertAt.set(job, now);
  const email = getEmail();
  if (!email.delivers) return;
  try {
    await email.send({
      to,
      subject: `Questor: background job "${job}" failed`,
      text: `The background job "${job}" failed on ${INSTANCE_ID} at ${new Date().toISOString()}.\n\n${message}\n\nSee GET /api/admin/ops for recent runs. This alert is sent at most once an hour per job.`,
      html: `<p>The background job <b>${job}</b> failed on ${INSTANCE_ID} at ${new Date().toISOString()}.</p><pre>${message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c))}</pre><p>See <code>GET /api/admin/ops</code> for recent runs. This alert is sent at most once an hour per job.</p>`,
    });
  } catch (err) {
    logger.error({ job, err: err instanceof Error ? err.message : String(err) }, 'Could not send job-failure alert');
  }
}

/** The latest run of every job, for the operations view. */
export async function latestJobRuns(): Promise<Array<{ name: string; startedAt: Date; finishedAt: Date | null; ok: boolean | null; note: string; holder: string }>> {
  const names = await prisma.jobRun.findMany({ distinct: ['name'], select: { name: true }, orderBy: { name: 'asc' } });
  const latest = await Promise.all(names.map((n) =>
    prisma.jobRun.findFirst({ where: { name: n.name }, orderBy: { startedAt: 'desc' }, select: { name: true, startedAt: true, finishedAt: true, ok: true, note: true, holder: true } }),
  ));
  return latest.filter((r): r is NonNullable<typeof r> => r !== null);
}

/** Test hook: forget alert throttling. */
export function _resetJobAlerts(): void {
  lastAlertAt.clear();
}
