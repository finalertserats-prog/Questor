import { prisma } from '../db.js';
import { config } from '../config.js';
import { DELIVER_EVERY_MS } from './webhooks.js';
import { RATE_LIMIT_PURGE_EVERY_MS } from '../middleware/rateLimit.js';
import { RETENTION_SWEEP_EVERY_MS } from './dataRights.js';
import { INCOMPLETE_SWEEP_EVERY_MS } from './incompleteInterviews.js';
import {
  formatDuration, type CheckContext, type CheckDef, type CheckOutcome, type HealthDeps, type SectionDef,
} from './systemHealthTypes.js';

/**
 * Is each background job running, recently, and succeeding? The names and
 * intervals are the ones src/index.ts starts, imported from the modules that
 * schedule them so the two cannot drift apart.
 */

/** A job whose last run is older than this many intervals is late... */
export const JOB_WARN_INTERVALS = 3;
/** ...and this many, stopped. */
export const JOB_FAIL_INTERVALS = 10;
/** A 15-second job skipping one tick under load is not news. */
export const JOB_MIN_WARN_MS = 60_000;

interface KnownJob {
  readonly name: string;
  readonly label: string;
  readonly intervalMs: number;
  /** Why the job is not scheduled on this deployment, or null when it is. */
  readonly notScheduled: (deps: HealthDeps) => string | null;
}

export const KNOWN_JOBS: readonly KnownJob[] = [
  { name: 'webhook-delivery', label: 'Webhook delivery', intervalMs: DELIVER_EVERY_MS, notScheduled: () => null },
  { name: 'incomplete-sweep', label: 'Interrupted-interview sweep', intervalMs: INCOMPLETE_SWEEP_EVERY_MS, notScheduled: () => null },
  {
    name: 'rate-limit-purge', label: 'Rate-limit cleanup', intervalMs: RATE_LIMIT_PURGE_EVERY_MS,
    notScheduled: () => (config.rateLimitStore === 'database' ? null : 'Not scheduled: rate-limit counters are kept in memory, so there is nothing to purge.'),
  },
  {
    name: 'retention-sweep', label: 'Retention sweep', intervalMs: RETENTION_SWEEP_EVERY_MS,
    notScheduled: (deps) => (deps.env.RETENTION_SWEEP_ENABLED === 'true' ? null : 'Not scheduled: the retention sweep is switched off (see Delivery and obligations).'),
  },
];

const ADDRESS = /\b(?:[a-z][a-z0-9+.-]*:\/\/[^\s]+|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?|[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d+)/gi;
const SECRET_NAME = /KEY|SECRET|PASS|TOKEN|DATABASE_URL/;

/**
 * A job's note is usually an error message, and error messages carry
 * connection strings and internal addresses. The operator needs the gist, not
 * those.
 */
export function redactNote(note: string, env: Readonly<Record<string, string | undefined>>): string {
  let text = note.slice(0, 300);
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 6 && SECRET_NAME.test(name)) text = text.split(value).join('[redacted]');
  }
  return text.replace(ADDRESS, '[address]');
}

type LatestRun = { startedAt: Date; finishedAt: Date | null; ok: boolean | null; note: string } | null;

export function judgeJob(job: KnownJob, run: LatestRun, deps: HealthDeps): CheckOutcome {
  const now = deps.now().getTime();
  const every = `runs every ${formatDuration(job.intervalMs)}`;
  const warnAfter = Math.max(job.intervalMs * JOB_WARN_INTERVALS, JOB_MIN_WARN_MS);
  const failAfter = job.intervalMs * JOB_FAIL_INTERVALS;
  const logs = 'Read `pm2 logs questor` for the job name, fix the cause, and confirm a later successful run.';

  if (!run) {
    // A job that waits one interval before its first tick has not failed just
    // because the process started a minute ago.
    if (deps.uptimeSeconds() * 1000 < warnAfter) {
      return { status: 'info', summary: `Waiting for its first run since the server started (${every}).` };
    }
    return { status: 'fail', summary: 'Has never run.', detail: `This job ${every}.`, action: logs };
  }
  if (run.ok === false) {
    return {
      status: 'fail', summary: `Last run failed ${formatDuration(now - run.startedAt.getTime())} ago.`,
      detail: run.note ? `Reason: ${redactNote(run.note, deps.env)}` : undefined, action: logs,
    };
  }
  const age = now - (run.finishedAt ?? run.startedAt).getTime();
  const summary = run.ok === null
    ? `Running now (started ${formatDuration(age)} ago).`
    : `Last succeeded ${formatDuration(age)} ago.`;
  const late = age > failAfter ? 'fail' : age > warnAfter ? 'warn' : null;
  if (!late) return { status: 'ok', summary, detail: `This job ${every}.` };
  // Jobs stop on purpose while a process drains; that is the drain's problem to report.
  if (deps.isDraining()) return { status: 'warn', summary, detail: 'Paused while this process shuts down.' };
  return {
    status: late, summary, detail: `This job ${every}, so it is overdue.`,
    action: run.ok === null ? 'A run has been going for too long; it may be stuck. ' + logs : logs,
  };
}

function jobCheck(job: KnownJob): CheckDef {
  return {
    id: `job-${job.name}`,
    label: job.label,
    run: async ({ deps }: CheckContext) => {
      const reason = job.notScheduled(deps);
      if (reason) return { status: 'info', summary: reason };
      const run = await prisma.jobRun.findFirst({
        where: { name: job.name },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true, finishedAt: true, ok: true, note: true },
      });
      return judgeJob(job, run, deps);
    },
  };
}

export const jobsSection: SectionDef = {
  id: 'jobs',
  title: 'Background jobs',
  checks: KNOWN_JOBS.map(jobCheck),
};
