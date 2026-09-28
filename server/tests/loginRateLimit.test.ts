import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { hashPassword } from '../src/services/auth.js';
import {
  LOGIN_FAILURES_PER_ACCOUNT, LOGIN_FAILURES_PER_ADDRESS,
  _enableRateLimitsInTests, _resetRateLimits, _useRateLimitStore,
} from '../src/middleware/rateLimit.js';

/**
 * S1: ten successful sign-ins from one address locked out everyone behind it.
 *
 * The login limiter consumed a unit BEFORE the handler ran, so it counted
 * successes as well as failures, and it keyed on the client address. One
 * office behind one NAT shares one address, so the eleventh person to sign in
 * that quarter-hour was told "Too many requests" and could not work
 * (docs/qa/resilience-2026-09-23.md, S1).
 *
 * What replaces it: failures are counted, not requests; the tight ceiling is
 * per ACCOUNT, which is what stands between an attacker and someone's
 * password; and a much looser per-address ceiling remains for broad abuse.
 */

const PASSWORD = 'correct-horse-battery';
const OFFICE = '203.0.113.9';
const ELSEWHERE = '198.51.100.4';

let tenantId = '';

/** Ten colleagues behind one office router. */
const staff = Array.from({ length: 12 }, (_, i) => `person${i}@office.example`);

beforeAll(async () => {
  await wipe();
  const demo = await createDemoData();
  tenantId = demo.tenantId;
  await prisma.user.createMany({
    data: staff.map((email) => ({
      tenantId, email, name: email, role: 'recruiter', passwordHash: hashPassword(PASSWORD),
    })),
  });
});

beforeEach(() => {
  _resetRateLimits();
  // The explicit opt-in: limiters are off under NODE_ENV=test, so no shipped
  // test covered any limit. This file is about the limit, so it asks for it.
  _enableRateLimitsInTests(true);
});

afterEach(() => {
  _enableRateLimitsInTests(false);
  _useRateLimitStore(null);
  _resetRateLimits();
});

const signIn = (app: ReturnType<typeof createApp>, email: string, password: string, ip = OFFICE) =>
  request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('an office behind one address', () => {
  it('lets everyone sign in, however many of them there are', async () => {
    const app = createApp();
    const statuses: number[] = [];
    for (const email of staff) statuses.push((await signIn(app, email, PASSWORD)).status);
    expect(statuses).toEqual(staff.map(() => 200));
  });

  it('lets a colleague sign in after someone else fumbled their password', async () => {
    const app = createApp();
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT + 2; i++) await signIn(app, staff[0], 'wrong-password-entirely');
    expect((await signIn(app, staff[1], PASSWORD)).status).toBe(200);
  });

  it('lets the same person sign in again and again', async () => {
    const app = createApp();
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) statuses.push((await signIn(app, staff[0], PASSWORD)).status);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });
});

describe('guessing one account', () => {
  it('refuses once the account has been guessed at too often', async () => {
    const app = createApp();
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT + 1; i++) statuses.push((await signIn(app, staff[2], 'wrong-password-entirely')).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it('counts the failures, not the attempts: the first N are answered honestly', async () => {
    const app = createApp();
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT; i++) statuses.push((await signIn(app, staff[3], 'wrong-password-entirely')).status);
    expect(new Set(statuses)).toEqual(new Set([401]));
  });

  it('follows the account, not the address: a new address does not reset it', async () => {
    const app = createApp();
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT; i++) await signIn(app, staff[4], 'wrong-password-entirely', OFFICE);
    expect((await signIn(app, staff[4], 'wrong-password-entirely', ELSEWHERE)).status).toBe(429);
  });

  it('still lets the real person in with the real password', async () => {
    // Raised by Codex on the first pass: refusing before the handler makes an
    // exhausted account bucket a lockout button — anyone who knows an address
    // could spend it. Only an answer that would have been a refusal anyway
    // becomes 429, so a guess past the ceiling gains nothing and the person
    // whose account it is still signs in.
    const app = createApp();
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT; i++) await signIn(app, staff[5], 'wrong-password-entirely');
    expect((await signIn(app, staff[5], PASSWORD)).status).toBe(200);
  });

  it('answers a wrong password past the ceiling as the limit, not as a credential', async () => {
    const app = createApp();
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT; i++) await signIn(app, staff[10], 'wrong-password-entirely');
    const res = await signIn(app, staff[10], 'wrong-password-entirely');
    expect([res.status, res.body.error]).toEqual([429, 'Too many requests. Please wait a moment and try again.']);
  });

  it('bounds a burst that arrives all at once, not only a serial run', async () => {
    // Raised by Codex on the first pass: a check that does not consume lets a
    // burst all pass before any of it has failed, and the attacker chooses the
    // burst size. An attempt in flight now counts against the ceiling.
    const app = createApp();
    const wrong = Array.from({ length: LOGIN_FAILURES_PER_ACCOUNT * 4 }, () => signIn(app, staff[11], 'wrong-password-entirely'));
    const statuses = (await Promise.all(wrong)).map((r) => r.status);
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(LOGIN_FAILURES_PER_ACCOUNT);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  }, 60_000);

  it('says how long to wait', async () => {
    const app = createApp();
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT; i++) await signIn(app, staff[6], 'wrong-password-entirely');
    const res = await signIn(app, staff[6], 'wrong-password-entirely');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not confirm whether the account exists', async () => {
    const app = createApp();
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT + 1; i++) await signIn(app, 'nobody@office.example', 'wrong-password-entirely');
    const res = await signIn(app, 'nobody@office.example', 'wrong-password-entirely');
    expect(res.body.error).toBe('Too many requests. Please wait a moment and try again.');
  });
});

describe('the address ceiling that remains', () => {
  it('is far looser than the per-account one', () => {
    expect(LOGIN_FAILURES_PER_ADDRESS).toBeGreaterThanOrEqual(LOGIN_FAILURES_PER_ACCOUNT * 5);
  });

  it('meters attempts that are already past an account ceiling', async () => {
    // Without this, hammering ONE account accrues nothing against the address
    // at all: every attempt past its ceiling answers 429 and, if 429 did not
    // count, the address bucket would never move.
    const app = createApp();
    for (let i = 0; i < LOGIN_FAILURES_PER_ADDRESS + 5; i++) await signIn(app, staff[7], 'wrong-password-entirely');
    // A different account, same address: the address bucket is what refuses now.
    expect((await signIn(app, staff[8], PASSWORD)).status).toBe(429);
  }, 120_000);

  it('still stops one address grinding through many accounts', async () => {
    const app = createApp();
    let refused = 0;
    // Each account gets one failure, so no per-account bucket is anywhere near
    // its ceiling: only the address bucket can refuse this.
    for (let i = 0; i < LOGIN_FAILURES_PER_ADDRESS + 5; i++) {
      const res = await signIn(app, `stranger${i}@office.example`, 'wrong-password-entirely');
      if (res.status === 429) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });
});

describe('when the counter store cannot be reached', () => {
  it('refuses rather than becoming an unmetered guessing window', async () => {
    const app = createApp();
    _useRateLimitStore({
      name: 'database',
      async hit() { throw new Error('store down'); },
      async peek() { throw new Error('store down'); },
    });
    const res = await signIn(app, staff[7], 'wrong-password-entirely');
    expect(res.status).toBe(503);
  });

  it('does not leak why', async () => {
    const app = createApp();
    _useRateLimitStore({
      name: 'database',
      async hit() { throw new Error('store down'); },
      async peek() { throw new Error('store down'); },
    });
    const res = await signIn(app, staff[8], 'wrong-password-entirely');
    expect(JSON.stringify(res.body)).not.toContain('store down');
  });
});

describe('the test opt-in itself', () => {
  it('leaves limiters off unless a test asks for them', async () => {
    _enableRateLimitsInTests(false);
    const app = createApp();
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT + 5; i++) statuses.push((await signIn(app, staff[9], 'wrong-password-entirely')).status);
    expect(new Set(statuses)).toEqual(new Set([401]));
  });
});

// ---------------------------------------------------------------------------
// The masking itself, raised by Codex on the second pass: the subject bucket
// lets the handler run and corrects the answer on its way out, so it must
// cover EVERY way a handler can write one. Covering only res.json would leave
// a credential oracle open on any path that answered another way.
// ---------------------------------------------------------------------------

describe('a refusal past the account ceiling, however it is written', () => {
  const overTheCeiling = async (app: ReturnType<typeof createApp>, email: string) => {
    for (let i = 0; i < LOGIN_FAILURES_PER_ACCOUNT; i++) await signIn(app, email, 'wrong-password-entirely');
  };

  it('is masked when the handler answers with res.json', async () => {
    const app = createApp();
    await overTheCeiling(app, staff[0]);
    expect((await signIn(app, staff[0], 'wrong-password-entirely')).status).toBe(429);
  }, 60_000);

  it('is masked when a route answers with res.status().send()', async () => {
    const app = createApp();
    app.post('/api/auth/login', (_req, res) => { res.status(401).send('Invalid credentials'); });
    await overTheCeiling(app, staff[1]);
    const res = await signIn(app, staff[1], 'wrong-password-entirely');
    expect([res.status, res.body.error]).toEqual([429, 'Too many requests. Please wait a moment and try again.']);
  }, 60_000);

  it('is masked when a route answers with res.sendStatus()', async () => {
    const app = createApp();
    app.post('/api/auth/login', (_req, res) => { res.sendStatus(403); });
    await overTheCeiling(app, staff[2]);
    expect((await signIn(app, staff[2], 'wrong-password-entirely')).status).toBe(429);
  }, 60_000);

  it('is masked when a route answers with res.end()', async () => {
    const app = createApp();
    app.post('/api/auth/login', (_req, res) => { res.status(401).end(); });
    await overTheCeiling(app, staff[3]);
    expect((await signIn(app, staff[3], 'wrong-password-entirely')).status).toBe(429);
  }, 60_000);

  it('leaves a success alone whichever way it is written', async () => {
    const app = createApp();
    app.post('/api/auth/login', (_req, res) => { res.status(200).send('fine'); });
    await overTheCeiling(app, staff[4]);
    expect((await signIn(app, staff[4], PASSWORD)).status).toBe(200);
  }, 60_000);
});

describe('one limiter does not shrink another', () => {
  it('keeps in-flight attempts on separate limiters apart', async () => {
    // Raised by Codex on the second pass: keyed on the bucket alone, a burst
    // on one limiter would shrink another limiter's ceiling for the same
    // address — a refusal on an empty bucket.
    const app = createApp();
    const registrations = Array.from({ length: 40 }, () =>
      request(app).post('/api/auth/register').set('X-Forwarded-For', OFFICE).send({}));
    const signedIn = signIn(app, staff[6], PASSWORD);
    const [res] = await Promise.all([signedIn, Promise.all(registrations)]);
    expect(res.status).toBe(200);
  }, 60_000);
});
