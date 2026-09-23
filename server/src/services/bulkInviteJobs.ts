import { nanoid } from 'nanoid';
import { logger } from '../logger.js';

/**
 * Bulk invite, off the request.
 *
 * `POST /interviews/bulk-invite` did a database round trip and an outbound
 * email per row inside one request: 19 ms a row against an instant local
 * relay, so 200 rows took 3.8 s — and with a real mail provider at 300 ms a
 * send it is a minute, which a reverse proxy read timeout ends before it
 * finishes. The recruiter would then not know which half went
 * (docs/qa/resilience-2026-09-23.md §2.3).
 *
 * The rows are now sent by a job, a few at a time, and the request hands back
 * whatever is done when it stops waiting. A batch that finishes inside
 * WAIT_FOR_MS — which is every batch the app sends today — answers exactly as
 * it did, results and all; a longer one answers 202 with a job id to collect.
 * Either way no request is held open for a minute and no row is lost from the
 * report.
 *
 * IN MEMORY, DELIBERATELY. A job is a view of work whose real record is
 * elsewhere: every row writes an Invitation row and an audit event as it goes,
 * so a restart loses the progress VIEW, never the invitations. A durable job
 * table would be a migration for a thing that lives for thirty seconds.
 */

/** How long the request waits before handing back a job id instead. */
export const WAIT_FOR_MS = 2_000;
/** How many rows are in flight at once. Enough to hide mail latency, few enough not to hold the pool. */
export const ROWS_AT_ONCE = 4;
/** How long a finished job can still be collected. */
export const JOB_RETENTION_MS = 30 * 60_000;
/** A ceiling, so a busy afternoon cannot grow this without limit. */
const MAX_JOBS = 200;

export interface BulkInviteRowResult {
  readonly index: number;
  readonly candidateId?: string;
  readonly sessionId?: string;
  readonly success: boolean;
  readonly error?: string;
  readonly invitation?: unknown;
}

export interface BulkInviteJob {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly total: number;
  readonly results: BulkInviteRowResult[];
  finished: boolean;
  startedAt: number;
  endedAt: number | null;
}

export interface BulkInviteView {
  readonly jobId: string;
  readonly total: number;
  readonly done: number;
  readonly finished: boolean;
  readonly results: readonly BulkInviteRowResult[];
}

const jobs = new Map<string, BulkInviteJob>();

function sweep(now: number): void {
  for (const [id, job] of jobs) {
    if (job.finished && job.endedAt !== null && now - job.endedAt > JOB_RETENTION_MS) jobs.delete(id);
  }
  for (const id of jobs.keys()) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(id);
  }
}

export function viewOf(job: BulkInviteJob): BulkInviteView {
  // Sorted by index, so a caller reading a half-done job still gets its rows
  // in the order it sent them.
  const results = [...job.results].sort((a, b) => a.index - b.index);
  return { jobId: job.id, total: job.total, done: results.length, finished: job.finished, results };
}

/**
 * Run `row(i)` for every row, ROWS_AT_ONCE at a time, recording each outcome
 * as it lands. Never rejects: a row that throws is the row's own failure, and
 * `row` is expected to have turned it into a result already.
 */
async function drain(job: BulkInviteJob, row: (index: number) => Promise<BulkInviteRowResult>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < job.total; index = next++) {
      try {
        job.results.push(await row(index));
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), jobId: job.id, index }, 'bulk invite row threw');
        job.results.push({ index, success: false, error: 'Invitation failed' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ROWS_AT_ONCE, Math.max(1, job.total)) }, worker));
}

/**
 * Start the job and wait a moment for it. Resolves as soon as the work is done
 * or `WAIT_FOR_MS` has passed, whichever comes first; the job keeps running
 * either way.
 */
export async function runBulkInvite(
  owner: { tenantId: string; userId: string },
  total: number,
  row: (index: number) => Promise<BulkInviteRowResult>,
  waitForMs = WAIT_FOR_MS,
): Promise<BulkInviteView> {
  const now = Date.now();
  sweep(now);
  const job: BulkInviteJob = {
    id: nanoid(16), tenantId: owner.tenantId, userId: owner.userId, total,
    results: [], finished: false, startedAt: now, endedAt: null,
  };
  jobs.set(job.id, job);

  const work = drain(job, row).then(() => {
    job.finished = true;
    job.endedAt = Date.now();
  });
  // The rejection cannot happen (drain swallows), but an unhandled one would
  // take the process down, so it is claimed here as well.
  work.catch((err: unknown) => logger.error({ err: String(err), jobId: job.id }, 'bulk invite job failed'));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitForMs); });
  timer?.unref?.();
  await Promise.race([work, waited]);
  clearTimeout(timer);
  return viewOf(job);
}

/**
 * A job, for the person who started it. Scoped to the user and the tenant:
 * the results carry candidate ids and delivery outcomes, and nobody else's
 * job is theirs to read.
 */
export function bulkInviteJob(id: string, owner: { tenantId: string; userId: string }): BulkInviteView | null {
  sweep(Date.now());
  const job = jobs.get(id);
  if (!job || job.tenantId !== owner.tenantId || job.userId !== owner.userId) return null;
  return viewOf(job);
}

/** Test hook — forget every job. */
export function _clearBulkInviteJobs(): void {
  jobs.clear();
}
