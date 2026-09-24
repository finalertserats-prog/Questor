import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '../src/providers/email/index.js';

const sent: EmailMessage[] = [];

vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test',
      configured: true,
      delivers: true,
      send: vi.fn(async (msg: EmailMessage) => {
        sent.push(msg);
        return { status: 'sent', id: `test-${sent.length}` };
      }),
    }),
  };
});

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { assertDemoCreationCap, purgeExpiredDemoTenants, releaseDemoEmail, requestDemoAccess } from '../src/services/demoAccess.js';

const app = createApp();
const OPERATOR = 'operator@example.com';
const VISITOR = { name: 'Asha Rao', email: 'asha@acme.test', company: 'Acme' };
const DAY_MS = 86_400_000;

/** The demo session travels only in the cookie; tests present it as a bearer. */
function sessionOf(res: { headers: Record<string, unknown> }): string {
  const cookies = (res.headers['set-cookie'] as string[] | undefined) ?? [];
  return /^questor_token=([^;]+)/.exec(cookies.find((c) => c.startsWith('questor_token=')) ?? '')?.[1] ?? '';
}

function linkTokenFrom(msg: EmailMessage | undefined): string {
  const m = /\/demo\/([A-Za-z0-9_-]{24,128})/.exec(`${msg?.text ?? ''} ${msg?.html ?? ''}`);
  if (!m) throw new Error('no demo link in email');
  return m[1];
}

function latestLinkToVisitor(): string {
  return linkTokenFrom([...sent].reverse().find((m) => m.to === VISITOR.email));
}

async function requestDemo(body: Record<string, string> = VISITOR, ip = '203.0.113.7') {
  return request(app).post('/api/demo/request').set('X-Forwarded-For', ip).send(body);
}

async function redeem(token: string) {
  return request(app).post('/api/demo/redeem').send({ token });
}

/** Age the sandbox past its lifetime and run the purge, as the nightly job would. */
async function purgeSandbox() {
  await prisma.tenant.updateMany({ where: { isDemo: true }, data: { demoExpiresAt: new Date(Date.now() - 1000) } });
  await purgeExpiredDemoTenants();
}

async function withLimiterOn<T>(fn: () => Promise<T>): Promise<T> {
  const nodeEnv = config.nodeEnv;
  (config as { nodeEnv: string }).nodeEnv = 'development';
  try {
    return await fn();
  } finally {
    (config as { nodeEnv: string }).nodeEnv = nodeEnv;
  }
}

beforeEach(async () => {
  sent.length = 0;
  await wipe();
  await prisma.demoGrant.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  config.signupApproverEmail = OPERATOR;
});

describe('H3: requesting a demo after the sandbox was purged', () => {
  it('sends a working link when the unused link expired and the sandbox was purged', async () => {
    await requestDemo();
    await prisma.demoGrant.updateMany({ data: { linkExpiresAt: new Date(Date.now() - 1000) } });
    await purgeSandbox();
    sent.length = 0;

    await requestDemo();

    expect((await redeem(latestLinkToVisitor())).status).toBe(200);
  });

  it('reuses the one grant row for the address instead of creating another', async () => {
    await requestDemo();
    await prisma.demoGrant.updateMany({ data: { linkExpiresAt: new Date(Date.now() - 1000) } });
    await purgeSandbox();

    await requestDemo();

    expect(await prisma.demoGrant.count()).toBe(1);
  });

  it('leaves exactly one live sandbox after re-provisioning', async () => {
    await requestDemo();
    await prisma.demoGrant.updateMany({ data: { linkExpiresAt: new Date(Date.now() - 1000) } });
    await purgeSandbox();

    await requestDemo();

    expect(await prisma.tenant.count({ where: { isDemo: true, demoExpiresAt: { gt: new Date() } } })).toBe(1);
  });

  it('extends the sandbox lifetime when an expired link is re-issued on a live sandbox', async () => {
    await requestDemo();
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { isDemo: true } });
    // The sandbox is a day from its purge; the fresh 72-hour link must not outlive it.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { demoExpiresAt: new Date(Date.now() + DAY_MS) } });
    await prisma.demoGrant.updateMany({ data: { linkExpiresAt: new Date(Date.now() - 1000) } });

    await requestDemo();

    const grant = await prisma.demoGrant.findFirstOrThrow();
    const after = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(after.demoExpiresAt!.getTime()).toBeGreaterThan(grant.linkExpiresAt!.getTime());
  });

  it('mints a new link for a live but lost link and retires the old one', async () => {
    await requestDemo();
    const first = latestLinkToVisitor();
    sent.length = 0;

    await requestDemoAccess({ ...VISITOR, ip: '203.0.113.7', now: new Date(Date.now() + 11 * 60_000) });

    const second = latestLinkToVisitor();
    expect({ oldStatus: (await redeem(first)).status, newStatus: (await redeem(second)).status }).toEqual({ oldStatus: 410, newStatus: 200 });
  });

  it('does not notify the operator again when a lost link is re-sent', async () => {
    await requestDemo();
    sent.length = 0;

    await requestDemoAccess({ ...VISITOR, ip: '203.0.113.7', now: new Date(Date.now() + 11 * 60_000) });

    expect(sent.map((m) => m.to)).toEqual([VISITOR.email]);
  });
});

describe('H3: redeeming a link whose sandbox is gone', () => {
  it('does not consume the grant when the sandbox no longer exists', async () => {
    await requestDemo();
    const token = latestLinkToVisitor();
    await purgeSandbox();

    await redeem(token);

    expect((await prisma.demoGrant.findFirstOrThrow()).status).toBe('sent');
  });

  it('answers that the link expired and may be requested again', async () => {
    await requestDemo();
    const token = latestLinkToVisitor();
    await purgeSandbox();

    const res = await redeem(token);

    expect({ status: res.status, reason: res.body.reason, canRequestAgain: res.body.canRequestAgain }).toEqual({ status: 410, reason: 'expired', canRequestAgain: true });
  });

  it('lets the visitor ask again from that link and get a working one, without the operator', async () => {
    await requestDemo();
    const token = latestLinkToVisitor();
    await purgeSandbox();
    sent.length = 0;

    await request(app).post('/api/demo/reaccess').send({ token });

    expect({ toOperator: sent.filter((m) => m.to === OPERATOR).length, redeemed: (await redeem(latestLinkToVisitor())).status }).toEqual({ toOperator: 0, redeemed: 200 });
  });
});

describe('L10: a declined grant', () => {
  async function declined() {
    await requestDemo();
    await redeem(latestLinkToVisitor());
    await requestDemo();
    const msg = sent.find((m) => m.to === OPERATOR && /decision/.test(`${m.text} ${m.html}`));
    const decision = /\/demo\/decision\/([A-Za-z0-9_-]{24,128})/.exec(`${msg?.text ?? ''} ${msg?.html ?? ''}`)![1];
    await request(app).post(`/api/demo/decision/${decision}`).send({ decision: 'decline' });
    sent.length = 0;
  }

  it('does not email the operator again when the visitor asks again', async () => {
    await declined();

    await requestDemo();
    await requestDemo();

    expect(sent.filter((m) => m.to === OPERATOR)).toHaveLength(0);
  });

  it('stays declined when the visitor asks again', async () => {
    await declined();

    await requestDemo();

    expect((await prisma.demoGrant.findFirstOrThrow()).status).toBe('declined');
  });
});

describe('M5: an address that already has a real account', () => {
  async function realUser(email: string) {
    const tenant = await prisma.tenant.create({ data: { name: 'Real Org' } });
    return prisma.user.create({ data: { tenantId: tenant.id, email, name: 'Real', passwordHash: 'x', role: 'admin' } });
  }

  it("builds a sandbox without touching the real account", async () => {
    const real = await realUser(VISITOR.email);

    await requestDemoAccess({ ...VISITOR, ip: '203.0.113.7' });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: real.id } });
    expect({ sandboxes: await prisma.tenant.count({ where: { isDemo: true } }), email: after.email, tenantId: after.tenantId }).toEqual({ sandboxes: 1, email: VISITOR.email, tenantId: real.tenantId });
  });
});

describe('M5: releaseDemoEmail', () => {
  it('frees the address held by a demo user so a real account can take it', async () => {
    await requestDemo();
    await prisma.user.updateMany({ where: { tenant: { isDemo: true } }, data: { email: VISITOR.email } });

    await releaseDemoEmail(VISITOR.email);

    const tenant = await prisma.tenant.create({ data: { name: 'Real Org' } });
    const created = prisma.user.create({ data: { tenantId: tenant.id, email: VISITOR.email, name: 'Real', passwordHash: 'x', role: 'admin' } });
    await expect(created).resolves.toBeTruthy();
  });

  it('retires the sandbox that held the address', async () => {
    await requestDemo();
    await prisma.user.updateMany({ where: { tenant: { isDemo: true } }, data: { email: VISITOR.email } });

    await releaseDemoEmail(VISITOR.email);

    expect(await prisma.tenant.count({ where: { isDemo: true, demoExpiresAt: { gt: new Date() } } })).toBe(0);
  });

  it('leaves a real account with that address untouched', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Real Org' } });
    await prisma.user.create({ data: { tenantId: tenant.id, email: 'real@acme.test', name: 'Real', passwordHash: 'x', role: 'admin' } });

    const released = await releaseDemoEmail('real@acme.test');

    expect({ released, kept: await prisma.user.count({ where: { email: 'real@acme.test' } }) }).toEqual({ released: false, kept: 1 });
  });
});

describe('M3: the demo request limiter', () => {
  it('does not throttle a signed-in demo using its own endpoints', async () => {
    const statuses = await withLimiterOn(async () => {
      await requestDemo();
      const session = await redeem(latestLinkToVisitor());
      const auth = `Bearer ${sessionOf(session)}`;
      const out: number[] = [];
      for (let i = 0; i < 6; i += 1) out.push((await request(app).get('/api/demo/interview').set('Authorization', auth)).status);
      return out;
    });
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('still throttles demo requests from one network', async () => {
    const statuses = await withLimiterOn(async () => {
      const out: number[] = [];
      for (let i = 0; i < 7; i += 1) out.push((await requestDemo({ ...VISITOR, email: `v${i}@acme.test` })).status);
      return out;
    });
    expect(statuses).toContain(429);
  });
});

describe('M4: demo sandboxes in public organisation lookup', () => {
  it('leaves demo sandboxes out of the name search', async () => {
    await requestDemo();
    await prisma.tenant.create({ data: { name: 'Acme Real', slug: 'acme-real' } });

    const res = await request(app).get('/api/orgs?q=acm');

    expect(res.body.orgs.map((o: { slug: string }) => o.slug)).toEqual(['acme-real']);
  });

  it('does not resolve a demo sandbox by its slug', async () => {
    await requestDemo();
    const sandbox = await prisma.tenant.findFirstOrThrow({ where: { isDemo: true } });

    const res = await request(app).get(`/api/orgs/${sandbox.slug}`);

    expect(res.status).toBe(404);
  });
});

describe('L14: demo creation caps under concurrency', () => {
  it('lets no more creations through than the cap leaves room for when checks race', async () => {
    await requestDemo();
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { isDemo: true } });
    // The sandbox holds its sample role and the visitor may add three more.
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => assertDemoCreationCap(tenant.id, 'roles')));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
});
