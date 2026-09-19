import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { INSTANCE_ID } from '../src/services/jobs.js';
import {
  _catalogRefreshSettled, runCatalogRefresh, scheduledCatalogRefreshTick, shouldRunScheduledCatalogRefresh, startManualCatalogRefresh,
} from '../src/services/catalogRefresh.js';
import { CATALOG_REFRESH_LEASE } from '../src/services/catalogRefreshRun.js';
import { configureCatalogRefresh, seedSmallCatalog, testDeps } from './catalogRefreshFixtures.js';

/**
 * Monthly, robust to restarts: a 6-hourly tick starts a run only when the last
 * completed one is 28 days old, never two at once, and a run left behind by a
 * dead instance is resumed rather than blocking forever.
 */

const DAY = 86_400_000;

beforeEach(async () => {
  configureCatalogRefresh();
  await seedSmallCatalog();
});

async function completedRun(daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * DAY);
  return prisma.catalogRefreshRun.create({ data: { trigger: 'schedule', status: 'completed', startedAt: at, finishedAt: at } });
}

async function holdLease() {
  await prisma.jobLease.create({ data: { name: CATALOG_REFRESH_LEASE.name, holder: 'other-host:1:abc', expiresAt: new Date(Date.now() + 60_000) } });
}

describe('whether a scheduled run is due', () => {
  it('is due when no run has ever completed', async () => {
    expect(await shouldRunScheduledCatalogRefresh(new Date())).toBe(true);
  });

  it('is not due 27 days after the last completed run', async () => {
    await completedRun(27);
    expect(await shouldRunScheduledCatalogRefresh(new Date())).toBe(false);
  });

  it('is due 28 days after the last completed run', async () => {
    await completedRun(28);
    expect(await shouldRunScheduledCatalogRefresh(new Date())).toBe(true);
  });

  it('is not due while another instance holds the lease', async () => {
    await holdLease();
    expect(await shouldRunScheduledCatalogRefresh(new Date())).toBe(false);
  });

  it('is due when a run left behind by a dead instance is waiting to resume', async () => {
    await completedRun(3);
    await prisma.catalogRefreshRun.create({ data: { trigger: 'schedule', status: 'running', startedAt: new Date(Date.now() - 2 * 60 * 60_000) } });
    expect(await shouldRunScheduledCatalogRefresh(new Date())).toBe(true);
  });
});

describe('the scheduled tick', () => {
  it('does nothing when not due', async () => {
    await completedRun(1);
    expect(await scheduledCatalogRefreshTick(testDeps({}).deps)).toBe('not due');
  });

  it('runs a scheduled refresh when due', async () => {
    await scheduledCatalogRefreshTick(testDeps({}).deps);
    const run = await prisma.catalogRefreshRun.findFirstOrThrow();
    expect({ trigger: run.trigger, status: run.status }).toEqual({ trigger: 'schedule', status: 'completed' });
  });

  it('resumes a stale running row instead of being blocked by it', async () => {
    const stale = await prisma.catalogRefreshRun.create({ data: { trigger: 'schedule', status: 'running', startedAt: new Date(Date.now() - 2 * CATALOG_REFRESH_LEASE.ttlMs - 60_000) } });
    await scheduledCatalogRefreshTick(testDeps({}).deps);
    expect((await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('completed');
  });

  it('marks a running row too old to resume as failed and starts afresh', async () => {
    const abandoned = await prisma.catalogRefreshRun.create({ data: { trigger: 'schedule', status: 'running', startedAt: new Date(Date.now() - 8 * DAY) } });
    await scheduledCatalogRefreshTick(testDeps({}).deps);
    const [old, runs] = await Promise.all([prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: abandoned.id } }), prisma.catalogRefreshRun.count()]);
    expect({ status: old.status, runs }).toEqual({ status: 'failed', runs: 2 });
  });
});

describe('never two runs at once', () => {
  it('lets only one of two simultaneous runs do the work', async () => {
    const slow = testDeps({}, { afterChunk: () => new Promise((resolve) => setTimeout(resolve, 20)) }).deps;
    const outcomes = await Promise.all([runCatalogRefresh({ trigger: 'manual', deps: slow }), runCatalogRefresh({ trigger: 'manual', deps: slow })]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['ran', 'skipped']);
  });

  it('skips a run while another instance holds the lease', async () => {
    await holdLease();
    expect((await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps })).outcome).toBe('skipped');
  });
});

async function realUserId(): Promise<string> {
  const tenant = await prisma.tenant.create({ data: { name: 'Owner Org', users: { create: { email: `owner-${Date.now()}-${Math.random()}@x.test`, name: 'Owner', passwordHash: 'x', role: 'admin' } } }, include: { users: true } });
  return tenant.users[0].id;
}

describe('starting a run by hand', () => {
  it('answers with the run id before the run has finished', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = await startManualCatalogRefresh(await realUserId(), testDeps({}, { afterChunk: () => gate }).deps);
    const statusWhileRunning = started.kind === 'started' ? (await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: started.runId } })).status : 'none';
    release();
    await _catalogRefreshSettled();
    expect({ kind: started.kind, statusWhileRunning }).toEqual({ kind: 'started', statusWhileRunning: 'running' });
  });

  it('records who started it', async () => {
    const userId = await realUserId();
    const started = await startManualCatalogRefresh(userId, testDeps({}).deps);
    await _catalogRefreshSettled();
    const run = started.kind === 'started' ? await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: started.runId } }) : null;
    expect({ trigger: run?.trigger, by: run?.triggeredById }).toEqual({ trigger: 'manual', by: userId });
  });

  it('reports busy while a run holds the lease', async () => {
    await holdLease();
    expect(await startManualCatalogRefresh('user-1', testDeps({}).deps)).toEqual({ kind: 'busy' });
  });

  it('reports a failure, not busy, when the run cannot even be recorded', async () => {
    const started = await startManualCatalogRefresh('no-such-user', testDeps({}).deps);
    await _catalogRefreshSettled();
    expect(started).toEqual({ kind: 'failed' });
  });

  it('uses this instance id for the lease it holds', async () => {
    let holder = '';
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}, { afterChunk: async () => { holder = (await prisma.jobLease.findUniqueOrThrow({ where: { name: CATALOG_REFRESH_LEASE.name } })).holder; } }).deps });
    expect(holder).toBe(INSTANCE_ID);
  });
});
