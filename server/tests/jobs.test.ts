import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EmailMessage } from '../src/providers/email/index.js';

const sent: EmailMessage[] = [];
vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      send: vi.fn(async (msg: EmailMessage) => { sent.push(msg); return { status: 'sent', id: `t${sent.length}` }; }),
    }),
  };
});

import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { runExclusive, latestJobRuns, _resetJobAlerts } from '../src/services/jobs.js';

/**
 * Background work under a database lease. Two instances, or one restarting
 * mid-run, must not do the same work twice; a failure must be recorded and
 * told to someone.
 */
beforeEach(async () => {
  sent.length = 0;
  _resetJobAlerts();
  config.signupApproverEmail = 'operator@example.com';
  await prisma.jobRun.deleteMany();
  await prisma.jobLease.deleteMany();
});

describe('running a job under a lease', () => {
  it('runs the work when the lease is free', async () => {
    const outcome = await runExclusive('unit-job', 60_000, async () => 'done');

    expect(outcome).toBe('ran');
  });

  it('lets only one of two simultaneous runners do the work', async () => {
    let started = 0;
    const slow = async () => { started += 1; await new Promise((r) => setTimeout(r, 150)); };

    const outcomes = await Promise.all([runExclusive('race-job', 60_000, slow), runExclusive('race-job', 60_000, slow)]);

    expect([outcomes.sort(), started]).toEqual([['ran', 'skipped'], 1]);
  });

  it('frees the lease once the work is done', async () => {
    await runExclusive('again-job', 60_000, async () => undefined);

    const second = await runExclusive('again-job', 60_000, async () => undefined);

    expect(second).toBe('ran');
  });

  it('takes over a lease whose holder never came back', async () => {
    await prisma.jobLease.create({ data: { name: 'stale-job', holder: 'crashed-instance', expiresAt: new Date(Date.now() - 1000) } });

    const outcome = await runExclusive('stale-job', 60_000, async () => undefined);

    expect(outcome).toBe('ran');
  });
});

describe('when a job fails', () => {
  it('records the failure with the reason', async () => {
    await runExclusive('broken-job', 60_000, async () => { throw new Error('disk on fire'); });

    const [run] = await latestJobRuns();
    expect([run.ok, run.note]).toEqual([false, 'disk on fire']);
  });

  it('does not throw to the scheduler', async () => {
    await expect(runExclusive('broken-job', 60_000, async () => { throw new Error('boom'); })).resolves.toBe('failed');
  });

  it('emails the operator', async () => {
    await runExclusive('alert-job', 60_000, async () => { throw new Error('boom'); });

    expect(sent.find((m) => m.to === 'operator@example.com')?.subject).toContain('alert-job');
  });

  it('emails at most once an hour for the same job', async () => {
    await runExclusive('noisy-job', 60_000, async () => { throw new Error('boom'); });
    await runExclusive('noisy-job', 60_000, async () => { throw new Error('boom again'); });

    expect(sent.filter((m) => m.subject.includes('noisy-job'))).toHaveLength(1);
  });

  it('still frees the lease', async () => {
    await runExclusive('free-after-fail', 60_000, async () => { throw new Error('boom'); });

    expect(await runExclusive('free-after-fail', 60_000, async () => undefined)).toBe('ran');
  });
});

describe('the operations view of jobs', () => {
  it('reports the latest run per job', async () => {
    await runExclusive('view-job', 60_000, async () => 'first');
    await runExclusive('view-job', 60_000, async () => 'second');

    const runs = await latestJobRuns();
    expect(runs.find((r) => r.name === 'view-job')?.note).toBe('second');
  });
});
