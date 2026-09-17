import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import {
  runExclusive, startJob, stopAllJobs, runningJobCount, releaseHeldLeases, INSTANCE_ID, _resetJobsForTest,
} from '../src/services/jobs.js';

/**
 * Background jobs during a shutdown drain. A process on its way out must not
 * start new sweeps, must let a sweep already running finish, and must hand
 * back its leases so the next instance does not wait out a TTL to take over.
 */

beforeEach(async () => {
  _resetJobsForTest();
  await prisma.jobRun.deleteMany();
  await prisma.jobLease.deleteMany();
});

describe('jobs while shutting down', () => {
  it('skips a run once jobs have been stopped', async () => {
    stopAllJobs();

    const outcome = await runExclusive('after-stop', 60_000, async () => 'should not run');

    expect(outcome).toBe('skipped');
  });

  it('takes no lease once jobs have been stopped', async () => {
    stopAllJobs();

    await runExclusive('after-stop', 60_000, async () => undefined);

    expect(await prisma.jobLease.count()).toBe(0);
  });

  it('counts a run that is still in progress', async () => {
    const gate: { finish?: () => void } = {};
    const running = runExclusive('slow', 60_000, () => new Promise<void>((resolve) => { gate.finish = resolve; }));
    await expect.poll(() => gate.finish !== undefined).toBe(true);

    expect(runningJobCount()).toBe(1);
    gate.finish?.();
    await running;
  });

  it('stops counting a run once it has finished', async () => {
    await runExclusive('quick', 60_000, async () => undefined);

    expect(runningJobCount()).toBe(0);
  });

  it('stops a started job from ticking again', async () => {
    let runs = 0;
    startJob({ name: 'ticker', intervalMs: 20, delayFirst: true, fn: async () => { runs += 1; } });

    stopAllJobs();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(runs).toBe(0);
  });

  it('releases leases this instance still holds', async () => {
    await prisma.jobLease.create({ data: { name: 'held', holder: INSTANCE_ID, expiresAt: new Date(Date.now() + 600_000) } });

    await releaseHeldLeases();

    const lease = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'held' } });
    expect(lease.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('leaves another instance\'s lease alone', async () => {
    const until = new Date(Date.now() + 600_000);
    await prisma.jobLease.create({ data: { name: 'theirs', holder: 'other-host:1:abc', expiresAt: until } });

    await releaseHeldLeases();

    const lease = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'theirs' } });
    expect(lease.expiresAt.getTime()).toBe(until.getTime());
  });
});
