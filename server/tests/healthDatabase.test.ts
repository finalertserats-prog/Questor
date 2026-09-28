import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { probeDatabase, resetDatabaseProbe } from '../src/services/databaseProbe.js';

/**
 * /api/health must not say "ok" while the database is unreachable.
 *
 * On 2026-09-18 a deploy generated the wrong Prisma client: every sign-in
 * failed for 15 minutes while this endpoint — and the deploy's verify step,
 * which reads it — kept answering 200 "ok", because neither touched the
 * database.
 */

const app = createApp();

afterEach(() => {
  vi.restoreAllMocks();
  resetDatabaseProbe();
});

describe('probeDatabase', () => {
  it('is up when the ping answers', async () => {
    expect(await probeDatabase(async () => 1, 1000)).toBe(true);
  });

  it('is down when the ping fails', async () => {
    expect(await probeDatabase(async () => { throw new Error('connection refused'); }, 1000)).toBe(false);
  });

  it('is down when the ping does not answer in time', async () => {
    expect(await probeDatabase(() => new Promise(() => undefined), 20)).toBe(false);
  });

  it('shares one ping between checks that arrive together', async () => {
    let pings = 0;
    const slowPing = () => new Promise((resolve) => { pings += 1; setTimeout(() => resolve(1), 20); });
    await Promise.all([probeDatabase(slowPing, 1000), probeDatabase(slowPing, 1000), probeDatabase(slowPing, 1000)]);
    expect(pings).toBe(1);
  });

  it('never starts a second ping while an earlier one is still hung', async () => {
    let pings = 0;
    const hungPing = () => { pings += 1; return new Promise(() => undefined); };
    await probeDatabase(hungPing, 20);
    await probeDatabase(hungPing, 20);
    expect(pings).toBe(1);
  });

  it('still reports down while the earlier ping is hung', async () => {
    const hungPing = () => new Promise(() => undefined);
    await probeDatabase(hungPing, 20);
    expect(await probeDatabase(async () => 1, 20)).toBe(false);
  });

  it('gives up on a ping hung past the abandon window and sees the recovery', async () => {
    const hungPing = () => new Promise(() => undefined);
    await probeDatabase(hungPing, 20, 30);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await probeDatabase(async () => 1, 20, 30)).toBe(true);
  });
});

describe('GET /api/health', () => {
  it('reports the database as ok when it answers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.database).toBe('ok');
  });

  it('answers 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('the URL must start with the protocol `file:`'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
  });

  it('does not call itself ok when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('connection refused'));
    const res = await request(app).get('/api/health');
    expect(res.body).toMatchObject({ status: 'unavailable', database: 'unreachable' });
  });

  it('never reveals why the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('password authentication failed for user "questor"'));
    const res = await request(app).get('/api/health');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('still names the running build when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('connection refused'));
    const res = await request(app).get('/api/health');
    expect(res.body.commit).toBeTruthy();
  });
});
