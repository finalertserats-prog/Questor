import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EmailMessage } from '../src/providers/email/index.js';

const sent: EmailMessage[] = [];
const mail = { failNext: false };
vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      send: vi.fn(async (msg: EmailMessage) => {
        if (mail.failNext) {
          mail.failNext = false;
          throw new Error('mail relay down');
        }
        sent.push(msg);
        return { status: 'sent', id: `t${sent.length}` };
      }),
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
  mail.failNext = false;
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

  it('never lets two runners do the work at the same time', async () => {
    // The guarantee is no overlap. Counting runs was timing-dependent: on
    // Postgres the second runner's first query can land after the first has
    // finished and released the lease, and then running is correct.
    let active = 0;
    let maxActive = 0;
    const slow = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 150));
      active -= 1;
    };

    const outcomes = await Promise.all([runExclusive('race-job', 60_000, slow), runExclusive('race-job', 60_000, slow)]);

    expect({ maxActive, ranAtLeastOnce: outcomes.includes('ran') }).toEqual({ maxActive: 1, ranAtLeastOnce: true });
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

describe('renewing a lease during long work', () => {
  it('extends the lease for the run holding it', async () => {
    let renewed = false;
    await runExclusive('long-job', 1_000, async (lease) => { renewed = await lease.renew(60_000); });
    expect(renewed).toBe(true);
  });

  it('pushes the expiry out while the work runs', async () => {
    let expiresInMs = 0;
    await runExclusive('long-job', 1_000, async (lease) => {
      await lease.renew(60_000);
      const row = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'long-job' } });
      expiresInMs = row.expiresAt.getTime() - Date.now();
    });
    expect(expiresInMs).toBeGreaterThan(30_000);
  });

  it('refuses to renew once another run took the lease, even in this same instance', async () => {
    // The first run's lease lapses mid-work and a second run in this process
    // takes it. A lease keyed only on the instance would let both renew and
    // both carry on; each acquisition has its own token instead.
    let firstRenewed: boolean | null = null;
    let secondRan = false;
    await runExclusive('shared-job', 60_000, async (first) => {
      await prisma.jobLease.update({ where: { name: 'shared-job' }, data: { expiresAt: new Date(Date.now() - 1) } });
      await runExclusive('shared-job', 60_000, async () => { secondRan = true; });
      // The second run released its lease on finishing; take it again as a third holder.
      await runExclusive('shared-job', 60_000, async () => {
        firstRenewed = await first.renew(60_000);
      });
    });
    expect({ secondRan, firstRenewed }).toEqual({ secondRan: true, firstRenewed: false });
  });

  it('never releases a lease a later run of this instance now holds', async () => {
    let heldBySecond = false;
    await runExclusive('release-job', 60_000, async () => {
      await prisma.jobLease.update({ where: { name: 'release-job' }, data: { expiresAt: new Date(Date.now() - 1) } });
      void runExclusive('release-job', 60_000, async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const row = await prisma.jobLease.findUniqueOrThrow({ where: { name: 'release-job' } });
    heldBySecond = row.expiresAt.getTime() > Date.now();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(heldBySecond).toBe(true);
  });

  it('refuses to renew a lease another instance holds', async () => {
    let renewed: boolean | null = null;
    await runExclusive('theirs-later', 60_000, async (lease) => {
      await prisma.jobLease.update({ where: { name: 'theirs-later' }, data: { holder: 'other-host:1:abc#zz' } });
      renewed = await lease.renew(60_000);
    });
    expect(renewed).toBe(false);
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

  it('tries the alert again on the next failure when the alert itself could not be sent', async () => {
    mail.failNext = true;
    await runExclusive('unlucky-job', 60_000, async () => { throw new Error('boom'); });
    await runExclusive('unlucky-job', 60_000, async () => { throw new Error('boom again'); });

    expect(sent.filter((m) => m.subject.includes('unlucky-job'))).toHaveLength(1);
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
