import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// Every preview miss is a paid synthesis, so the route is rate limited per
// user. The limiter no-ops under NODE_ENV=test, so this file forces it on.
vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, nodeEnv: 'development' } };
});

const { createApp } = await import('../src/app.js');
const { wipe, createDemoData } = await import('../src/seed/demoData.js');
const { signToken } = await import('../src/services/auth.js');
const { _resetRateLimits } = await import('../src/middleware/rateLimit.js');

const app = createApp();
let bearer = '';

beforeAll(async () => {
  await wipe();
  _resetRateLimits();
  const ids = await createDemoData();
  bearer = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
});

describe('interviewer preview rate limit', () => {
  it('refuses previews past the per-user limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await request(app).get('/api/interviewers/maya/preview').set('Authorization', bearer)).status);
    }
    expect([statuses.slice(0, 30).every((s) => s === 204), statuses[30]]).toEqual([true, 429]);
  });
});
