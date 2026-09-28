import { startJob } from './jobs.js';
import { purgeExpiredImportBatches } from './candidateImport.js';

/**
 * Removes bulk imports nobody finished. Always on, unlike the retention sweep:
 * a staged row is a working copy with a one-day life, never a record anyone
 * has decided to keep.
 */
export const IMPORT_PURGE_JOB = { name: 'candidate-import-purge', intervalMs: 60 * 60_000, ttlMs: 10 * 60_000 } as const;

export function startImportPurge(intervalMs: number = IMPORT_PURGE_JOB.intervalMs): () => void {
  return startJob({ ...IMPORT_PURGE_JOB, intervalMs, delayFirst: true, fn: async () => `purged ${await purgeExpiredImportBatches()} expired imports` });
}
