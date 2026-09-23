import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROWS_AT_ONCE, bulkInviteJob, runBulkInvite, _clearBulkInviteJobs,
  type BulkInviteRowResult,
} from '../src/services/bulkInviteJobs.js';

/**
 * §2.3: bulk invite was a database round trip and an outbound email per row
 * inside one request — 19 ms a row against an instant local relay, so 200 rows
 * took 3.8 s. With a real mail provider at 300 ms a send that is a minute,
 * which a reverse proxy read timeout ends before it finishes, and the
 * recruiter is left not knowing which half went.
 */

const owner = { tenantId: 't1', userId: 'u1' };

afterEach(() => {
  _clearBulkInviteJobs();
});

const ok = (index: number): BulkInviteRowResult => ({ index, candidateId: `c${index}`, success: true });
const slow = (ms: number) => async (index: number): Promise<BulkInviteRowResult> => {
  await new Promise((r) => setTimeout(r, ms));
  return ok(index);
};

describe('a batch that finishes quickly', () => {
  it('answers with every result, as it always did', async () => {
    const view = await runBulkInvite(owner, 3, async (i) => ok(i));
    expect(view.results.map((r) => r.candidateId)).toEqual(['c0', 'c1', 'c2']);
  });

  it('says it is finished, so the route answers 200', async () => {
    expect((await runBulkInvite(owner, 3, async (i) => ok(i))).finished).toBe(true);
  });

  it('keeps the rows in the order they were sent', async () => {
    // Later rows finish first, so only the sort keeps the order honest.
    const view = await runBulkInvite(owner, 8, async (i) => {
      await new Promise((r) => setTimeout(r, (8 - i) * 5));
      return ok(i);
    });
    expect(view.results.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('a batch that does not', () => {
  it('returns promptly rather than holding the request open', async () => {
    const began = Date.now();
    await runBulkInvite(owner, 20, slow(200), 150);
    expect(Date.now() - began).toBeLessThan(1_000);
  }, 20_000);

  it('says it is not finished, so the route answers 202', async () => {
    const view = await runBulkInvite(owner, 20, slow(200), 150);
    expect(view.finished).toBe(false);
  }, 20_000);

  it('hands back a job id to collect it with', async () => {
    const view = await runBulkInvite(owner, 20, slow(200), 150);
    expect(typeof view.jobId === 'string' && view.jobId.length > 0).toBe(true);
  }, 20_000);

  it('carries the rows already done', async () => {
    const view = await runBulkInvite(owner, 40, slow(60), 200);
    expect(view.done).toBeGreaterThan(0);
    expect(view.done).toBeLessThan(40);
  }, 20_000);

  it('keeps going after the request has gone', async () => {
    const view = await runBulkInvite(owner, 12, slow(40), 60);
    await vi.waitFor(() => {
      const later = bulkInviteJob(view.jobId, owner);
      expect(later?.finished).toBe(true);
      expect(later?.results).toHaveLength(12);
    }, { timeout: 10_000, interval: 25 });
  }, 20_000);

  it('sends several rows at once rather than one after another', async () => {
    let live = 0;
    let peak = 0;
    await runBulkInvite(owner, 12, async (i) => {
      peak = Math.max(peak, ++live);
      await new Promise((r) => setTimeout(r, 30));
      live--;
      return ok(i);
    }, 10_000);
    expect(peak).toBe(ROWS_AT_ONCE);
  }, 20_000);
});

describe('per-row errors survive', () => {
  it('reports a row that failed with its own message', async () => {
    const view = await runBulkInvite(owner, 3, async (i) => (
      i === 1 ? { index: i, candidateId: 'c1', success: false, error: 'Interview not found' } : ok(i)
    ));
    expect(view.results.map((r) => [r.success, r.error ?? null]))
      .toEqual([[true, null], [false, 'Interview not found'], [true, null]]);
  });

  it('does not let one row that throws end the run', async () => {
    const view = await runBulkInvite(owner, 4, async (i) => {
      if (i === 2) throw new Error('the driver fell over');
      return ok(i);
    });
    expect(view.results).toHaveLength(4);
    expect(view.results[2]).toEqual({ index: 2, success: false, error: 'Invitation failed' });
  });

  it('never returns the underlying message for a row that threw', async () => {
    const view = await runBulkInvite(owner, 1, async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432'); });
    expect(JSON.stringify(view)).not.toContain('ECONNREFUSED');
  });
});

describe('collecting a job', () => {
  it('is refused for someone else in the same organisation', async () => {
    const view = await runBulkInvite(owner, 2, slow(50), 1);
    expect(bulkInviteJob(view.jobId, { tenantId: 't1', userId: 'someone-else' })).toBeNull();
  }, 20_000);

  it('is refused for another organisation', async () => {
    const view = await runBulkInvite(owner, 2, slow(50), 1);
    expect(bulkInviteJob(view.jobId, { tenantId: 't2', userId: 'u1' })).toBeNull();
  }, 20_000);

  it('answers the same for an unknown id as for one that is not theirs', async () => {
    const view = await runBulkInvite(owner, 2, slow(50), 1);
    expect(bulkInviteJob('no-such-job', owner) === bulkInviteJob(view.jobId, { tenantId: 't2', userId: 'u1' })).toBe(true);
  }, 20_000);

  it('works for the person who started it', async () => {
    const view = await runBulkInvite(owner, 2, async (i) => ok(i));
    expect(bulkInviteJob(view.jobId, owner)?.total).toBe(2);
  });
});

describe('an empty batch', () => {
  it('finishes immediately with nothing', async () => {
    const view = await runBulkInvite(owner, 0, async (i) => ok(i));
    expect({ finished: view.finished, results: view.results }).toEqual({ finished: true, results: [] });
  });
});
