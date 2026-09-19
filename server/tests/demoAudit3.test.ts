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
import { ensureCatalogSeeded } from '../src/services/catalogSeed.js';
import { slugifyCatalogName } from '../src/domain/catalogText.js';
import { demoRecipientBlocked, provisionDemoTenant, purgeExpiredDemoTenants } from '../src/services/demoAccess.js';

const app = createApp();
const OPERATOR = 'operator@example.com';
const VISITOR = { name: 'Asha Rao', email: 'asha@acme.test', company: 'Acme' };

function linkFrom(msg: EmailMessage | undefined, prefix = '/demo/'): string {
  const m = new RegExp(`${prefix}([A-Za-z0-9_-]{24,128})`).exec(`${msg?.text ?? ''} ${msg?.html ?? ''}`);
  if (!m) throw new Error('no link in email');
  return m[1];
}
const latestTo = (to: string) => [...sent].reverse().find((m) => m.to === to && /\/demo\/[A-Za-z0-9_-]{24}/.test(`${m.text} ${m.html}`));
const requestDemo = (body: Record<string, string> = VISITOR) => request(app).post('/api/demo/request').send(body);

async function signedIn() {
  await requestDemo();
  const res = await request(app).post('/api/demo/redeem').send({ token: linkFrom(latestTo(VISITOR.email)) });
  const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('questor_token='));
  const session = /^questor_token=([^;]+)/.exec(cookie ?? '')?.[1] ?? '';
  return { auth: `Bearer ${session}`, tenantId: res.body.tenant.id as string, res };
}

async function decisionToken(): Promise<string> {
  const msg = [...sent].reverse().find((m) => m.to === OPERATOR && /decision/.test(`${m.text} ${m.html}`));
  return linkFrom(msg, '/demo/decision/');
}

beforeEach(async () => {
  sent.length = 0;
  await wipe();
  await prisma.demoGrant.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  config.signupApproverEmail = OPERATOR;
});

describe('#2 demo visitors can add candidates', () => {
  it('lets a demo visitor add a candidate', async () => {
    const { auth, tenantId } = await signedIn();
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId } });

    const res = await request(app).post('/api/candidates').set('Authorization', auth).send({ fullName: 'Second Person', email: VISITOR.email, roleId: role.id });

    expect(res.status).toBe(201);
  });

  it('still keeps a demo visitor out of the admin area', async () => {
    const { auth } = await signedIn();

    const res = await request(app).get('/api/admin/users').set('Authorization', auth);

    expect(res.status).toBe(403);
  });
});

describe('#3 the demo user does not hold the visitor address', () => {
  async function realUser(email: string) {
    const tenant = await prisma.tenant.create({ data: { name: 'Real Org' } });
    return prisma.user.create({ data: { tenantId: tenant.id, email, name: 'Real', passwordHash: 'x', role: 'admin' } });
  }

  it('lets someone with a real account try the demo', async () => {
    await realUser(VISITOR.email);

    await requestDemo();

    expect(sent.some((m) => m.to === VISITOR.email)).toBe(true);
  });

  it('leaves the address free for a real account after a demo', async () => {
    await signedIn();

    await expect(realUser(VISITOR.email)).resolves.toBeTruthy();
  });

  it('still lets the sandbox email its visitor, and nobody else', async () => {
    const { tenantId } = await signedIn();

    expect([await demoRecipientBlocked(tenantId, VISITOR.email), await demoRecipientBlocked(tenantId, 'other@else.test')]).toEqual([false, true]);
  });
});

describe('#4 invitations sent during a demo', () => {
  it('stop working when the demo session ends', async () => {
    const { auth, tenantId } = await signedIn();
    const sample = await prisma.interviewSession.findFirstOrThrow({ where: { tenantId } });
    const session = await prisma.interviewSession.create({ data: { tenantId, candidateId: sample.candidateId, roleId: sample.roleId, scorecardId: sample.scorecardId } });

    const resent = await request(app).post(`/api/interviews/${session.id}/invite`).set('Authorization', auth);

    const grant = await prisma.demoGrant.findFirstOrThrow();
    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { sessionId: session.id } });
    expect({ status: resent.status, withinDemo: invitation.expiresAt!.getTime() <= grant.sessionEndsAt!.getTime() }).toEqual({ status: 200, withinDemo: true });
  });
});

describe('#5 re-sending a lost link', () => {
  it('re-sends at most once in ten minutes', async () => {
    const { requestDemoAccess } = await import('../src/services/demoAccess.js');
    await requestDemo();
    await requestDemo();
    await requestDemo();
    await requestDemoAccess({ ...VISITOR, ip: '203.0.113.7', now: new Date(Date.now() + 11 * 60_000) });

    expect(sent.filter((m) => m.to === VISITOR.email)).toHaveLength(2);
  });
});

describe('#6 the request form', () => {
  it('refuses a name carrying a link', async () => {
    const res = await requestDemo({ ...VISITOR, name: 'Click https://evil.example' });
    expect(res.status).toBe(400);
  });

  it('refuses a company spanning lines', async () => {
    const res = await requestDemo({ ...VISITOR, company: 'Acme\nVisit evil.example' });
    expect(res.status).toBe(400);
  });

  it('refuses a name carrying an address', async () => {
    const res = await requestDemo({ ...VISITOR, name: 'mail me@evil.example' });
    expect(res.status).toBe(400);
  });

  it('accepts an ordinary name and company', async () => {
    const res = await requestDemo({ ...VISITOR, name: "Siobhán O'Neil-Rao", company: 'Acme & Sons, Ltd.' });
    expect(res.status).toBe(202);
  });
});

describe('#7 the decision page after a decision', () => {
  it('shows the request as decided', async () => {
    const { res } = await signedIn();
    void res;
    await requestDemo();
    const token = await decisionToken();
    await request(app).post(`/api/demo/decision/${token}`).send({ decision: 'approve' });

    const page = await request(app).get(`/api/demo/decision/${token}`);

    expect({ status: page.status, state: page.body.state }).toEqual({ status: 200, state: 'decided' });
  });
});

describe('#8 personal data after the purge', () => {
  async function purged() {
    await requestDemo();
    // Purged after the link lapsed, as the sandbox outlives every link it is given.
    await prisma.demoGrant.updateMany({ data: { linkExpiresAt: new Date(Date.now() - 1000) } });
    await prisma.tenant.updateMany({ where: { isDemo: true }, data: { demoExpiresAt: new Date(Date.now() - 1000) } });
    await purgeExpiredDemoTenants();
    return prisma.demoGrant.findFirstOrThrow();
  }

  it('removes the name, company and plain address from the grant', async () => {
    const grant = await purged();
    expect([grant.name, grant.company, grant.email.includes('asha')]).toEqual(['', '', false]);
  });

  it('still treats the same address as the same grant afterwards', async () => {
    await purged();

    await requestDemo();

    expect(await prisma.demoGrant.count()).toBe(1);
  });

  it('does not store a hash of the requester IP', async () => {
    await requestDemo();
    expect((await prisma.demoGrant.findFirstOrThrow()).requestIpHash).toBe('');
  });
});

describe('#10 small demo fixes', () => {
  it('lets the visitor add three roles of their own beside the sample', async () => {
    const { tenantId } = await signedIn();
    const { assertDemoCreationCap } = await import('../src/services/demoAccess.js');
    const outcomes: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(await assertDemoCreationCap(tenantId, 'roles').then(() => true, () => false));
      await prisma.role.create({ data: { tenantId, title: `Role ${i}` } });
    }
    outcomes.push(await assertDemoCreationCap(tenantId, 'roles').then(() => true, () => false));
    expect(outcomes).toEqual([true, true, true, false]);
  });

  it('does not put the session token in the redeem response body', async () => {
    await requestDemo();
    const res = await request(app).post('/api/demo/redeem').send({ token: linkFrom(latestTo(VISITOR.email)) });
    expect({ status: res.status, token: res.body.token }).toEqual({ status: 200, token: undefined });
  });

  it('links the sample role to the seeded Data Engineer entry, not an org-added namesake', async () => {
    await ensureCatalogSeeded();
    // Created first in sort order and first in time would both favour it without a deterministic pick.
    const other = await prisma.catalogDomain.upsert({ where: { slug: 'aaa-first' }, create: { slug: 'aaa-first', name: 'AAA First', sortOrder: 0 }, update: {} });
    await prisma.catalogRole.upsert({ where: { domainId_normalizedTitle: { domainId: other.id, normalizedTitle: 'data engineer' } }, create: { domainId: other.id, title: 'Data Engineer', normalizedTitle: 'data engineer', source: 'org' }, update: {} });
    const p = await provisionDemoTenant({ ...VISITOR });
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId: p.tenantId }, include: { catalogRole: { include: { domain: true } } } });
    expect({ title: role.catalogRole?.normalizedTitle, domain: role.catalogRole?.domain.slug }).toEqual({ title: 'data engineer', domain: slugifyCatalogName('Data, Analytics & Decision Science') });
  });
});
