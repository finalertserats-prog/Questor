import { startJob } from './jobs.js';
import { purgeExpiredDemoTenants } from './demoAccess.js';

export const DEMO_PURGE_EVERY_MS = 24 * 60 * 60_000;

export function startDemoPurge(intervalMs = DEMO_PURGE_EVERY_MS): () => void {
  return startJob({ name: 'demo-purge', intervalMs, ttlMs: 60 * 60_000, delayFirst: true, fn: async () => `purged ${await purgeExpiredDemoTenants()} demo tenants` });
}
