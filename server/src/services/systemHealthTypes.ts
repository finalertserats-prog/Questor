import { promises as fsp } from 'node:fs';
import { config } from '../config.js';
import { isDraining } from './drainState.js';
import { resolveCommit } from './build.js';

/**
 * Shapes shared by the system health checks (see services/systemHealth.ts).
 *
 * Every check answers one question the runbook used to answer over SSH, in
 * words the owner can act on. `info` is for facts that are neither good nor
 * bad, and for signals the app cannot honestly judge; it never moves the
 * overall status.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';
export type OverallStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  readonly id: string;
  readonly label: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly action?: string;
  readonly value?: string | number;
}

export type CheckOutcome = Omit<HealthCheck, 'id' | 'label'>;

export interface HealthSection {
  readonly id: string;
  readonly title: string;
  readonly checks: HealthCheck[];
}

export interface HealthReport {
  readonly status: OverallStatus;
  readonly checkedAt: string;
  readonly commit: string;
  /** operator: the deployment and the operator's own organisation; tenant: only the caller's organisation. */
  readonly scope: 'operator' | 'tenant';
  readonly sections: HealthSection[];
}

export interface StatFsResult {
  readonly bavail: number;
  readonly blocks: number;
  readonly bsize: number;
}

/**
 * Everything a check reads from outside the database, injectable so tests
 * never touch a real disk, clock or environment.
 */
export interface HealthDeps {
  readonly now: () => Date;
  /** Read for optional switches (BACKUP_DIR, ALLOW_UNDELIVERED_EMAIL, ...). Values are never echoed. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly nodeEnv: string;
  /** Per-check deadline. */
  readonly timeoutMs: number;
  readonly statfs: (path: string) => Promise<StatFsResult>;
  readonly listDir: (path: string) => Promise<string[]>;
  readonly statFile: (path: string) => Promise<{ size: number; mtime: Date }>;
  /** The volume whose free space is reported. */
  readonly diskPath: string;
  readonly memoryRss: () => number;
  readonly uptimeSeconds: () => number;
  readonly isDraining: () => boolean;
  readonly commit: () => string;
  readonly databaseUrl: () => string;
}

export interface CheckContext {
  readonly deps: HealthDeps;
  readonly tenantId: string;
}

export interface CheckDef {
  readonly id: string;
  readonly label: string;
  readonly run: (ctx: CheckContext) => Promise<CheckOutcome>;
}

export interface SectionDef {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly CheckDef[];
}

/** Three seconds: long enough for a healthy query, short enough that a hung one does not hold the page. */
export const CHECK_TIMEOUT_MS = 3_000;

export function defaultHealthDeps(): HealthDeps {
  return {
    now: () => new Date(),
    env: process.env,
    nodeEnv: config.nodeEnv,
    timeoutMs: CHECK_TIMEOUT_MS,
    statfs: (path) => fsp.statfs(path),
    listDir: (path) => fsp.readdir(path),
    statFile: async (path) => {
      const s = await fsp.stat(path);
      return { size: s.size, mtime: s.mtime };
    },
    diskPath: process.cwd(),
    memoryRss: () => process.memoryUsage().rss,
    uptimeSeconds: () => process.uptime(),
    isDraining,
    commit: resolveCommit,
    databaseUrl: () => process.env.DATABASE_URL ?? '',
  };
}

/** "3 min", "5 h 12 min", "2 days 4 h". */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} days ${hours % 24} h` : `${days} days`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
