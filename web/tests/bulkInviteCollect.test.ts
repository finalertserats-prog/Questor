import { describe, expect, it, vi } from 'vitest';
import { INVITE_POLL_FOR_MS, collectInvites, type BulkInviteAnswer, type BulkInviteResult } from '../src/components/bulkInviteModel';

/**
 * §2.3: a bulk invite is a database write and an outbound email per row, so a
 * big batch outlives its own request. The server hands back a job id and the
 * rows done so far; this is the page collecting the rest, so a recruiter still
 * sees every row's outcome instead of a request that timed out halfway.
 */

const row = (i: number, success = true): BulkInviteResult => ({ candidateId: `c${i}`, success });
const noWait = async () => {};

describe('a batch the request finished', () => {
  it('is used as it stands, with no polling', async () => {
    const fetchJob = vi.fn();
    const answer: BulkInviteAnswer = { results: [row(1), row(2)] };
    expect(await collectInvites(answer, fetchJob, noWait)).toHaveLength(2);
    expect(fetchJob).not.toHaveBeenCalled();
  });

  it('is used as it stands when the job says it finished', async () => {
    const fetchJob = vi.fn();
    const answer: BulkInviteAnswer = { jobId: 'j1', finished: true, results: [row(1)] };
    expect(await collectInvites(answer, fetchJob, noWait)).toHaveLength(1);
    expect(fetchJob).not.toHaveBeenCalled();
  });
});

describe('a batch that outlived its request', () => {
  it('is collected until it is done', async () => {
    const fetchJob = vi.fn()
      .mockResolvedValueOnce({ jobId: 'j1', finished: false, results: [row(1), row(2)] })
      .mockResolvedValueOnce({ jobId: 'j1', finished: true, results: [row(1), row(2), row(3)] });
    const out = await collectInvites({ jobId: 'j1', finished: false, results: [row(1)] }, fetchJob, noWait);
    expect(out.map((r) => r.candidateId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('keeps every row, failures included', async () => {
    const fetchJob = vi.fn().mockResolvedValue({ jobId: 'j1', finished: true, results: [row(1), row(2, false)] });
    const out = await collectInvites({ jobId: 'j1', finished: false, results: [] }, fetchJob, noWait);
    expect(out.map((r) => r.success)).toEqual([true, false]);
  });

  it('gives up eventually rather than polling for ever', async () => {
    const fetchJob = vi.fn().mockResolvedValue({ jobId: 'j1', finished: false, results: [row(1)] });
    let clock = 0;
    const out = await collectInvites(
      { jobId: 'j1', finished: false, results: [] },
      fetchJob,
      async () => { clock += 1_000; },
      () => clock,
    );
    // The rows that DID land are still reported: knowing which half went is
    // the whole point of collecting at all.
    expect(out.map((r) => r.candidateId)).toEqual(['c1']);
    expect(fetchJob.mock.calls.length).toBeLessThanOrEqual(INVITE_POLL_FOR_MS / 1_000 + 1);
  });
});
