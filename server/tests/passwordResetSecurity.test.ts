import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import {
  _useRateLimitStore, _resetRateLimits, _enableRateLimitsInTests, LOGIN_FAILURES_PER_ACCOUNT,
} from '../src/middleware/rateLimit.js';
import { hashResetToken, serverPepperProbe } from './helpers/passwordResetProbe.js';

// The security properties the password routes are supposed to hold, each
// tested as a property rather than as a happy path: enumeration through words,
// through status codes and through the clock; a limiter that refuses rather
// than waves through when its counter store is unreachable; and a token that
// does not reach a log.

const app = createApp();
const PASSWORD = 'a-long-enough-passphrase';

/**
 * The limiters are off under nodeEnv 'test'; these tests are about them.
 *
 * Through the limiter module's own switch rather than by telling the process it
 * is in development, which these tests used to do — that also moved every other
 * production-versus-development branch underneath them, so they were quietly
 * testing two things at once.
 */
function limiterOn(): void { _enableRateLimitsInTests(true); }
function limiterOff(): void { _enableRateLimitsInTests(false); }

let known = '';

beforeAll(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Security Org' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: 'known@security.local', name: 'Known Person', passwordHash: hashPassword(PASSWORD), role: 'recruiter' } });
  known = user.email;
});

beforeEach(async () => {
  limiterOff();
  _useRateLimitStore(null);
  _resetRateLimits();
  await prisma.passwordResetToken.deleteMany({});
});

const forgot = (email: string) => request(app).post('/api/auth/password/forgot').send({ email });

describe('enumeration', () => {
  it('answers with the same status code for a known and an unknown address', async () => {
    const a = await forgot(known);
    const b = await forgot('nobody@security.local');
    expect(a.status).toBe(b.status);
  });

  it('answers with the same words', async () => {
    const a = await forgot(known);
    const b = await forgot('nobody@security.local');
    expect(a.body.message).toBe(b.body.message);
  });

  it('answers in the same time, because the work happens after the reply', async () => {
    // The reply must not wait on the lookup, the row or the mail server — all
    // of which only happen for an address that exists. Ten of each, compared on
    // the median so one slow scheduling tick does not decide the test.
    const time = async (email: string): Promise<number> => {
      const started = process.hrtime.bigint();
      await forgot(email);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    const hits: number[] = [];
    const misses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      hits.push(await time(known));
      misses.push(await time(`nobody-${i}@security.local`));
    }

    // A generous bound on purpose: this is a regression guard against someone
    // awaiting the send, which costs an SMTP round trip and would show up as
    // orders of magnitude, not as a few milliseconds of noise.
    const ratio = median(hits) / Math.max(median(misses), 0.1);
    expect(ratio).toBeLessThan(4);
  });

  it('gives a failed reset the same answer whoever the link belonged to', async () => {
    const reset = (token: string) => request(app).post('/api/auth/password/reset').send({ token, password: 'a-new-long-passphrase' });
    const a = await reset('a-token-that-was-never-issued');
    const b = await reset('another-token-never-issued-x');
    expect(a.status).toBe(b.status);
    expect(a.body.error).toBe(b.body.error);
    expect(a.body.error).not.toContain('@');
  });
});

describe('the limiters', () => {
  it('bounds how often one address can be sent a link', async () => {
    limiterOn();
    let last = 0;
    for (let i = 0; i < 8; i += 1) last = (await forgot(known)).status;
    expect(last).toBe(429);
  });

  it('counts an address the same however it was capitalised', async () => {
    limiterOn();
    for (let i = 0; i < 5; i += 1) await forgot(known);
    // Same mailbox, different spelling: it must land in the same bucket.
    expect((await forgot(known.toUpperCase())).status).toBe(429);
  });

  it('refuses rather than waves through when the counter store is unreachable', async () => {
    limiterOn();
    _useRateLimitStore({
      name: 'database',
      hit: async () => { throw new Error('the rate-limit store is unreachable'); },
    });

    const res = await forgot(known);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('briefly unavailable');
  });

  it('does not let a failed sign-in eat the budget for recovering from it', async () => {
    limiterOn();
    // Spend the sign-in limiter's per-account allowance entirely, reading the
    // ceiling from the limiter rather than restating it — that budget belongs
    // to the hardening lane and is theirs to tune.
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT + 2; i += 1) {
      await request(app).post('/api/auth/login').send({ email: known, password: 'wrong-password-here' });
    }

    // The property this test is named for: someone who has just locked
    // themselves out of signing in must still be able to ask for a way back.
    // Recovery has its own buckets and must never share the sign-in one.
    expect((await forgot(known)).status).toBe(202);
  });
});

describe('what is written down', () => {
  it('keeps the token out of the request line, so it cannot reach an access log', async () => {
    // The link puts the token in the URL fragment, which browsers never send.
    // Everything the server sees is a POST body.
    const { resetUrl } = await import('../src/services/passwordReset.js');
    const url = new URL(resetUrl('a-token-value-for-the-test'));
    expect(url.hash).toBe('#a-token-value-for-the-test');
    expect(url.pathname).toBe('/reset-password');
    expect(url.search).toBe('');
  });

  it('never logs the token, even when the limiter refuses the request', async () => {
    limiterOn();
    const lines: unknown[] = [];
    const { logger } = await import('../src/logger.js');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(((obj: unknown) => { lines.push(obj); }) as never);

    for (let i = 0; i < 40; i += 1) {
      await request(app).post('/api/auth/password/reset').send({ token: 'a-secret-token-value-here', password: 'a-new-long-passphrase' });
    }
    warn.mockRestore();

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('a-secret-token-value-here');
  });

  it('stores a hash that cannot be turned back into the link', async () => {
    const token = 'a-token-value-for-the-test';
    const hash = hashResetToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Under a different pepper the same token hashes differently, which is what
    // makes a stolen database useless without the environment it ran in.
    expect(serverPepperProbe('one-pepper', token)).not.toBe(serverPepperProbe('another-pepper', token));
  });
});

describe('privilege', () => {
  it('cannot be used to become someone else', async () => {
    const { requestPasswordReset } = await import('../src/services/passwordReset.js');
    const before = await prisma.user.findFirstOrThrow({ where: { email: known } });
    await requestPasswordReset(known, { ip: '1.2.3.4' });
    const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: before.id } });

    // The row names a user and nothing else. There is no role, no tenant and no
    // capability on it, so there is nothing for a forged or tampered row to
    // escalate into.
    expect(Object.keys(row).sort()).toEqual(
      ['consumedAt', 'createdAt', 'expiresAt', 'id', 'requestedBy', 'requestedById', 'supersededAt', 'tokenHash', 'userId'],
    );
    expect(row.userId).toBe(before.id);
  });

  it('is closed to someone who is not signed in at all', async () => {
    const res = await request(app).post('/api/auth/password/change').send({ currentPassword: PASSWORD, newPassword: 'a-new-long-passphrase' });
    expect(res.status).toBe(401);
  });

  it('changes only the caller, never a user named in the body', async () => {
    const tenant = await prisma.tenant.findFirstOrThrow();
    const victim = await prisma.user.create({ data: { tenantId: tenant.id, email: 'victim@security.local', name: 'Victim', passwordHash: hashPassword(PASSWORD), role: 'admin' } });
    const caller = await prisma.user.findFirstOrThrow({ where: { email: known } });
    const token = signToken({ userId: caller.id, tenantId: caller.tenantId, role: caller.role, email: caller.email, pv: caller.sessionsEpoch });

    await request(app).post('/api/auth/password/change').set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'a-new-long-passphrase', userId: victim.id, email: victim.email });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.passwordHash).toBe(victim.passwordHash);
    expect(after.role).toBe('admin');
  });
});
