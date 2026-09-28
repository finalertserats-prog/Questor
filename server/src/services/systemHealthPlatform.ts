import path from 'node:path';
import { prisma } from '../db.js';
import {
  formatBytes, formatDuration, plural,
  type CheckContext, type CheckDef, type CheckOutcome, type SectionDef,
} from './systemHealthTypes.js';

/**
 * Operator checks about the machine and the database: the runbook's
 * `pm2 status`, `df -h` and "is there a fresh dump?" answered from inside the
 * app. Deployment-wide, so only the operator ever sees them.
 */

/** A `SELECT 1` slower than this points at a struggling database. */
export const DB_SLOW_MS = 250;
/** Resident memory for one Node process. Past these, restarts and swapping follow. */
export const RSS_WARN_BYTES = 768 * 1024 * 1024;
export const RSS_FAIL_BYTES = 1536 * 1024 * 1024;
/** Free space on the app's volume, as a share of its size. */
export const DISK_WARN_FREE_RATIO = 0.15;
export const DISK_FAIL_FREE_RATIO = 0.05;
/** Nightly dumps: a missed night warns, two missed nights fail. */
export const BACKUP_WARN_AGE_MS = 26 * 60 * 60_000;
export const BACKUP_FAIL_AGE_MS = 50 * 60 * 60_000;
/** Where the production VPS keeps its dumps (docs/RUNBOOK.md). */
export const PRODUCTION_BACKUP_DIR = '/root/Questor/backups';
const BACKUP_FILE = /^questor-.*\.dump$/;

const database: CheckDef = {
  id: 'database',
  label: 'Database',
  run: async () => {
    const started = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const ms = Date.now() - started;
    if (ms > DB_SLOW_MS) {
      return {
        status: 'warn', value: ms, summary: `Reachable, but a trivial query took ${ms} ms.`,
        detail: `Anything over ${DB_SLOW_MS} ms for a one-row query suggests the database host is overloaded.`,
        action: 'Check the database host for load, locks or a long-running query.',
      };
    }
    return { status: 'ok', value: ms, summary: `Reachable; a trivial query took ${ms} ms.` };
  },
};

const isPostgres = (url: string) => url.startsWith('postgres://') || url.startsWith('postgresql://');

const migrations: CheckDef = {
  id: 'migrations',
  label: 'Database migrations',
  run: async ({ deps }) => {
    if (!isPostgres(deps.databaseUrl())) {
      return { status: 'info', summary: 'Not applicable: this database is SQLite, whose schema is applied with db push.' };
    }
    let rows: Array<{ applied: bigint | number; unfinished: bigint | number }>;
    try {
      rows = await prisma.$queryRaw`
        SELECT COUNT(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS applied,
               COUNT(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished
        FROM _prisma_migrations`;
    } catch {
      return {
        status: 'warn', summary: 'No migration history table was found.',
        action: 'Run scripts/deploy.sh, which records the baseline and applies migrations with prisma migrate deploy.',
      };
    }
    const applied = Number(rows[0]?.applied ?? 0);
    const unfinished = Number(rows[0]?.unfinished ?? 0);
    if (unfinished > 0) {
      return {
        status: 'fail', value: unfinished,
        summary: `${plural(unfinished, 'migration')} started but did not finish.`,
        detail: 'Prisma refuses further migrations until a failed one is resolved, so the next deploy will stop.',
        action: 'Inspect _prisma_migrations on the server, fix the cause, then run prisma migrate resolve.',
      };
    }
    return { status: 'ok', value: applied, summary: `${plural(applied, 'migration')} applied, none pending or failed.` };
  },
};

const processCheck: CheckDef = {
  id: 'process',
  label: 'Server process',
  run: async ({ deps }) => {
    const rss = deps.memoryRss();
    const up = formatDuration(deps.uptimeSeconds() * 1000);
    const summary = `Up ${up}, using ${formatBytes(rss)} of memory.`;
    const detail = 'Restart counts are kept by pm2; check `pm2 status questor` on the server if the uptime looks short.';
    if (rss > RSS_FAIL_BYTES) {
      return { status: 'fail', value: rss, summary, detail, action: 'Memory use is very high. Read the logs for a leak, then restart with the drain (see the runbook).' };
    }
    if (rss > RSS_WARN_BYTES) {
      return { status: 'warn', value: rss, summary, detail, action: 'Keep an eye on it; if it keeps rising, restart with the drain at a quiet time.' };
    }
    return { status: 'ok', value: rss, summary, detail };
  },
};

const draining: CheckDef = {
  id: 'draining',
  label: 'Accepting new interviews',
  run: async ({ deps }) => (deps.isDraining()
    ? {
      status: 'warn', summary: 'This process is shutting down and is refusing new interviews.',
      detail: 'Interviews already in progress are still being served. A deploy or restart normally ends this within the drain window.',
      action: 'If no deploy is running, check pm2: the new process may not have started.',
    }
    : { status: 'ok', summary: 'Yes. The server is not shutting down.' }),
};

export function judgeDisk(stats: { bavail: number; blocks: number; bsize: number }): CheckOutcome {
  if (!stats.blocks) return { status: 'info', summary: 'The volume did not report its size.' };
  const ratio = stats.bavail / stats.blocks;
  const percent = Math.floor(ratio * 100);
  const summary = `${percent}% free (${formatBytes(stats.bavail * stats.bsize)} of ${formatBytes(stats.blocks * stats.bsize)}).`;
  const action = 'Free space: remove old dumps and logs, or grow the volume. A full disk stops the database and the backups.';
  if (ratio < DISK_FAIL_FREE_RATIO) return { status: 'fail', value: percent, summary, action };
  if (ratio < DISK_WARN_FREE_RATIO) return { status: 'warn', value: percent, summary, action };
  return { status: 'ok', value: percent, summary };
}

const disk: CheckDef = {
  id: 'disk',
  label: 'Disk space',
  run: async ({ deps }) => ({
    ...judgeDisk(await deps.statfs(deps.diskPath)),
    detail: 'Measured on the volume the app runs from, which on the single VPS also holds the database and the dumps.',
  }),
};

const commit: CheckDef = {
  id: 'commit',
  label: 'Running build',
  run: async ({ deps }) => {
    const sha = deps.commit();
    return { status: 'info', value: sha, summary: `Commit ${sha.slice(0, 12)}.`, detail: 'Compare with the release you intended to deploy.' };
  },
};

/** BACKUP_DIR, or the VPS default in production; null when there is nowhere to look. */
export function backupDirOf(env: Readonly<Record<string, string | undefined>>, nodeEnv: string): string | null {
  const configured = env.BACKUP_DIR?.trim();
  if (configured) return configured;
  return nodeEnv === 'production' ? PRODUCTION_BACKUP_DIR : null;
}

async function newestBackup(ctx: CheckContext, dir: string): Promise<{ name: string; size: number; mtime: Date } | null> {
  const names = (await ctx.deps.listDir(dir)).filter((n) => BACKUP_FILE.test(n));
  const stats = await Promise.all(names.map(async (name) => ({ name, ...(await ctx.deps.statFile(path.join(dir, name))) })));
  return stats.reduce<(typeof stats)[number] | null>((best, s) => (!best || s.mtime > best.mtime ? s : best), null);
}

const backups: CheckDef = {
  id: 'latest-backup',
  label: 'Latest database backup',
  run: async (ctx) => {
    const dir = backupDirOf(ctx.deps.env, ctx.deps.nodeEnv);
    if (!dir) {
      return { status: 'info', summary: 'No backup folder is configured for this environment.', action: 'Set BACKUP_DIR to the folder the nightly dumps are written to.' };
    }
    let newest: Awaited<ReturnType<typeof newestBackup>>;
    try {
      newest = await newestBackup(ctx, dir);
    } catch {
      return {
        status: 'warn', summary: 'The app cannot see the backup folder.',
        detail: 'The folder named by BACKUP_DIR (or the production default) is missing or not readable by the app, so backups could not be checked from here.',
        action: 'Check the dumps on the server, and point BACKUP_DIR at the folder they are written to.',
      };
    }
    const rerun = 'Check the nightly backup script and its log on the server, then run it by hand.';
    if (!newest) {
      return { status: 'fail', value: 0, summary: 'No questor-*.dump files were found in the backup folder.', action: rerun };
    }
    const age = ctx.deps.now().getTime() - newest.mtime.getTime();
    const hours = Math.floor(age / 3_600_000);
    const detail = `Newest: ${newest.name}, ${formatBytes(newest.size)}.`;
    if (newest.size === 0) {
      return { status: 'fail', value: hours, summary: 'The newest backup file is empty.', detail, action: rerun };
    }
    const summary = `Last written ${formatDuration(age)} ago.`;
    if (age > BACKUP_FAIL_AGE_MS) return { status: 'fail', value: hours, summary, detail, action: rerun };
    if (age > BACKUP_WARN_AGE_MS) return { status: 'warn', value: hours, summary, detail, action: rerun };
    return { status: 'ok', value: hours, summary, detail: `${detail} Run the restore drill monthly (see the runbook).` };
  },
};

export const platformSection: SectionDef = {
  id: 'platform',
  title: 'Platform',
  checks: [database, migrations, processCheck, draining, disk, commit],
};

export const backupsSection: SectionDef = {
  id: 'backups',
  title: 'Backups',
  checks: [backups],
};
