import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * The credential limiter must not throttle ordinary use of the app.
 *
 * The 'auth' limiter (60 per 15 minutes per address) was mounted on all of
 * /api/auth, so GET /api/auth/me — which the web calls on every page load —
 * counted against it. A handful of HR users behind one office address hit the
 * ceiling in minutes and every page answered "Too many requests".
 */

const originalNodeEnv = config.nodeEnv;
let bearer = '';

/** The limiter is off under nodeEnv 'test'; these tests are about the limiter. */
function limiterOn(): void {
  (config as { nodeEnv: string }).nodeEnv = 'development';
}

afterEach(() => {
  (config as { nodeEnv: string }).nodeEnv = originalNodeEnv;
});

beforeAll(async () => {
  await wipe();
  const demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  bearer = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
});

describe('the auth rate limiter', () => {
  it('lets one address load /me on every page view without being throttled', async () => {
    const app = createApp();
    limiterOn();

    const statuses: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      statuses.push((await request(app).get('/api/auth/me').set('Authorization', bearer)).status);
    }

    expect(statuses.filter((s) => s !== 200)).toEqual([]);
  });

  it('does not count logout or tour completion against the credential limit', async () => {
    const app = createApp();
    limiterOn();

    const statuses: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      statuses.push((await request(app).post('/api/auth/tour/complete').set('Authorization', bearer)).status);
      statuses.push((await request(app).post('/api/auth/logout')).status);
    }

    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });

  it('still limits repeated sign-in attempts from one address', async () => {
    const app = createApp();
    limiterOn();

    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      last = (await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password' })).status;
    }

    expect(last).toBe(429);
  });

  it('still limits registration from one address', async () => {
    const app = createApp();
    limiterOn();

    let last = 0;
    for (let i = 0; i < 62; i += 1) {
      // Invalid bodies: counted by the limiter, never create a tenant.
      last = (await request(app).post('/api/auth/register').send({})).status;
    }

    expect(last).toBe(429);
  });
});
