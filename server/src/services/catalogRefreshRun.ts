import { prisma } from '../db.js';
import { config } from '../config.js';
import { nextRunCursor, parseCursor, type RefreshCursor, type RefreshStats } from './catalogRefreshState.js';

/**
 * The CatalogRefreshRun row: claiming (or resuming) one, saving progress after
 * every chunk, and deciding whether a scheduled run is due.
 */

export const CATALOG_REFRESH_LEASE = { name: 'catalog-refresh', ttlMs: 30 * 60_000 } as const;
/** "Monthly", measured from the last completed run so restarts cannot double it. */
export const MONTHLY_INTERVAL_MS = 28 * 24 * 60 * 60_000;
/**
 * An unfinished run younger than this is continued rather than replaced, so a
 * crash or an outage mid-run costs one chunk, not the month's progress.
 */
export const RESUME_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type RunTrigger = 'schedule' | 'manual';

export interface ClaimedRun {
  readonly id: string;
  readonly cursorJson: string;
  readonly statsJson: string;
  readonly llmCalls: number;
  readonly researchCalls: number;
  readonly resumed: boolean;
}

/** The newest unfinished run still worth continuing, if any. */
export async function resumableRun(now: Date) {
  const candidate = await prisma.catalogRefreshRun.findFirst({
    where: { status: { in: ['running', 'failed'] }, startedAt: { gte: new Date(now.getTime() - RESUME_WINDOW_MS) } },
    orderBy: { startedAt: 'desc' },
  });
  if (!candidate) return null;
  const newerCompleted = await prisma.catalogRefreshRun.findFirst({ where: { status: 'completed', startedAt: { gt: candidate.startedAt } }, select: { id: true } });
  return newerCompleted ? null : candidate;
}

async function previousCursor(): Promise<RefreshCursor | null> {
  const last = await prisma.catalogRefreshRun.findFirst({ where: { status: 'completed' }, orderBy: { startedAt: 'desc' }, select: { cursorJson: true } });
  return last ? parseCursor(last.cursorJson) : null;
}

/**
 * Called while holding the lease, so any row still marked running belongs to
 * an instance that died: it is resumed, never left to block the next run.
 */
export async function claimRun(trigger: RunTrigger, triggeredById: string | undefined, now: Date): Promise<ClaimedRun> {
  const unfinished = await resumableRun(now);
  if (unfinished) {
    await prisma.catalogRefreshRun.update({ where: { id: unfinished.id }, data: { status: 'running', error: '', finishedAt: null } });
    return { ...unfinished, resumed: true };
  }
  // Anything older than the window is abandoned as failed so it stops looking live.
  await prisma.catalogRefreshRun.updateMany({ where: { status: 'running' }, data: { status: 'failed', finishedAt: now, error: 'abandoned' } });
  const created = await prisma.catalogRefreshRun.create({
    data: { trigger, triggeredById: triggeredById ?? null, status: 'running', startedAt: now, cursorJson: JSON.stringify(nextRunCursor(await previousCursor())) },
  });
  return { ...created, resumed: false };
}

export async function saveRunProgress(runId: string, progress: { readonly cursor: RefreshCursor; readonly stats: RefreshStats; readonly llmCalls: number; readonly researchCalls: number }): Promise<void> {
  await prisma.catalogRefreshRun.update({
    where: { id: runId },
    data: { cursorJson: JSON.stringify(progress.cursor), statsJson: JSON.stringify(progress.stats), llmCalls: progress.llmCalls, researchCalls: progress.researchCalls },
  });
}

export async function finishRun(runId: string, now: Date): Promise<void> {
  await prisma.catalogRefreshRun.update({ where: { id: runId }, data: { status: 'completed', finishedAt: now, error: '' } });
}

/**
 * The row keeps a short code; the details go to the server log, since the
 * review page is no place for stack messages or database errors.
 */
export async function failRun(runId: string, code: string, now: Date): Promise<void> {
  await prisma.catalogRefreshRun.update({ where: { id: runId }, data: { status: 'failed', finishedAt: now, error: code } });
}

/** True while some instance holds the refresh lease, which is what "running" means. */
export async function isCatalogRefreshActive(now: Date): Promise<boolean> {
  const lease = await prisma.jobLease.findUnique({ where: { name: CATALOG_REFRESH_LEASE.name }, select: { expiresAt: true } });
  return lease !== null && lease.expiresAt.getTime() > now.getTime();
}

/**
 * Due when nothing is running and either an unfinished run is waiting to be
 * resumed or the last completed run is at least 28 days old.
 */
export async function shouldRunScheduledCatalogRefresh(now: Date): Promise<boolean> {
  if (await isCatalogRefreshActive(now)) return false;
  if (await resumableRun(now)) return true;
  const last = await prisma.catalogRefreshRun.findFirst({ where: { status: 'completed' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } });
  return !last?.finishedAt || now.getTime() - last.finishedAt.getTime() >= MONTHLY_INTERVAL_MS;
}

export const SPEND_WINDOW_MS = 30 * 24 * 60 * 60_000;

export interface SpendLimits {
  /** The run's llmCalls may not pass this. */
  readonly llmCalls: number;
  /** The run's researchCalls may not pass this. */
  readonly researchCalls: number;
}

/**
 * How far this run may spend: its per-run cap, and whatever the last 30 days
 * of runs left of the rolling budget. Without the rolling budget every manual
 * run would bring a fresh per-run allowance.
 */
export async function spendLimits(run: { readonly id: string; readonly llmCalls: number; readonly researchCalls: number }, now: Date): Promise<SpendLimits> {
  const others = await prisma.catalogRefreshRun.aggregate({
    where: { id: { not: run.id }, startedAt: { gte: new Date(now.getTime() - SPEND_WINDOW_MS) } },
    _sum: { llmCalls: true, researchCalls: true },
  });
  const cfg = config.catalogRefresh;
  const room = (own: number, perRun: number, perWindow: number, spentElsewhere: number) => own + Math.max(0, Math.min(perRun - own, perWindow - spentElsewhere - own));
  return {
    llmCalls: room(run.llmCalls, cfg.maxLlmCalls, cfg.llmCallsPer30Days, others._sum.llmCalls ?? 0),
    researchCalls: room(run.researchCalls, cfg.researchMaxCalls, cfg.researchCallsPer30Days, others._sum.researchCalls ?? 0),
  };
}

/** Proposals this run has already queued, by kind, whatever has happened to them since. */
export async function queuedCounts(runId: string): Promise<{ readonly aliases: number; readonly roles: number }> {
  const rows = await prisma.catalogProposal.groupBy({ by: ['kind'], where: { runId }, _count: { _all: true } });
  const count = (kind: string) => rows.find((r) => r.kind === kind)?._count._all ?? 0;
  return { aliases: count('new_alias'), roles: count('new_role') };
}

/** When the next manual run may start, or null if it may start now. */
export async function manualRunAllowedAt(now: Date): Promise<Date | null> {
  const gap = config.catalogRefresh.manualRunGapMs;
  if (gap <= 0) return null;
  const last = await prisma.catalogRefreshRun.findFirst({ where: { trigger: 'manual' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } });
  if (!last) return null;
  const allowedAt = new Date(last.startedAt.getTime() + gap);
  return allowedAt.getTime() > now.getTime() ? allowedAt : null;
}
