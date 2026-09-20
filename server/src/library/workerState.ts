import { prisma } from '../db.js';
import type { WorkerState } from './types.js';

/**
 * What the worker says about itself, kept in one row so the admin screen
 * (served by the API process) can show a process it never talks to directly.
 */

const ROW_ID = 'worker';

export interface WorkerStatus {
  readonly state: WorkerState;
  readonly reason: string;
  readonly holder: string;
  readonly since: Date;
  readonly lastBatchAt: Date | null;
  readonly lastError: string;
  readonly updatedAt: Date;
}

export async function setWorkerState(state: WorkerState, opts: { readonly reason?: string; readonly holder?: string; readonly lastError?: string; readonly batchFinished?: boolean } = {}): Promise<void> {
  const now = new Date();
  const current = await prisma.libraryWorkerState.findUnique({ where: { id: ROW_ID }, select: { state: true } });
  const changed = current?.state !== state;
  const data = {
    state,
    reason: opts.reason ?? '',
    ...(opts.holder !== undefined ? { holder: opts.holder } : {}),
    ...(opts.lastError !== undefined ? { lastError: opts.lastError.slice(0, 500) } : {}),
    ...(opts.batchFinished ? { lastBatchAt: now } : {}),
    ...(changed ? { since: now } : {}),
  };
  await prisma.libraryWorkerState.upsert({ where: { id: ROW_ID }, create: { id: ROW_ID, ...data, since: now }, update: data });
}

export async function getWorkerStatus(): Promise<WorkerStatus> {
  const row = await prisma.libraryWorkerState.findUnique({ where: { id: ROW_ID } });
  if (!row) return { state: 'stopped', reason: 'never started', holder: '', since: new Date(0), lastBatchAt: null, lastError: '', updatedAt: new Date(0) };
  return { state: row.state as WorkerState, reason: row.reason, holder: row.holder, since: row.since, lastBatchAt: row.lastBatchAt, lastError: row.lastError, updatedAt: row.updatedAt };
}
