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
import { demoRecipientBlocked, isHeuristicOnlySession, provisionDemoTenant, purgeExpiredDemoTenants } from '../src/services/demoAccess.js';

const app = createApp();
const OPERATOR = 'operator@example.com';
const VISITOR = { name: 'Asha Rao', email: 'asha@acme.test', company: 'Acme' };

function linkTokenFrom(msg: EmailMessage | undefined): string {
  const m = /\/demo\/([A-Za-z0-9_-]{24,128})/.exec(`${msg?.text ?? ''} ${msg?.html ?? ''}`);
  if (!m) throw new Error('no demo link in email');
  return m[1];
}

async function requestDemo(body: Record<string, string> = VISITOR, ip = '203.0.113.7') {
  return request(app).post('/api/demo/request').set('X-Forwarded-For', ip).send(body);
}

async function requestAndGetLink(): Promise<string> {
  await requestDemo();
  return linkTokenFrom(sent.find((m) => m.to === VISITOR.email));
}

beforeEach(async () => {
  sent.length = 0;
  await wipe();
  await prisma.demoGrant.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  config.signupApproverEmail = OPERATOR;
});

describe('POST /api/demo/request', () => {
  it('answers 202 with the same body for a new and a repeated address', async () => {
    const first = await requestDemo();
    const second = await requestDemo();
    expect([first.status, second.status, second.body]).toEqual([202, 202, first.body]);
  });

  it('emails the visitor a one-time link and tells the operator', async () => {
    await requestDemo();
    expect(sent.map((m) => m.to).sort()).toEqual([VISITOR.email, OPERATOR].sort());
  });

  it('creates one sandbox per address, not one per request', async () => {
    await requestDemo();
    await requestDemo();
    expect(await prisma.tenant.count({ where: { isDemo: true } })).toBe(1);
  });

  it('limits how many sandboxes one network can create', async () => {
    // The limiter is off under nodeEnv 'test'; this test is about the limiter.
    const nodeEnv = config.nodeEnv;
    (config as { nodeEnv: string }).nodeEnv = 'development';
    try {
      for (let i = 0; i < 8; i += 1) await requestDemo({ ...VISITOR, email: `v${i}@acme.test` });
    } finally {
      (config as { nodeEnv: string }).nodeEnv = nodeEnv;
    }
    expect(await prisma.tenant.count({ where: { isDemo: true } })).toBeLessThanOrEqual(5);
  });

  it('routes a returning visitor whose demo was used to the operator instead of a new sandbox', async () => {
    const token = await requestAndGetLink();
    await request(app).post('/api/demo/redeem').send({ token });
    sent.length = 0;

    await requestDemo();

    expect(await prisma.tenant.count({ where: { isDemo: true } })).toBe(1);
    expect(sent.map((m) => m.to)).toEqual([OPERATOR]);
  });
});

describe('sandbox provisioning', () => {
  it('leaves the interview for the visitor to consent to, as a real candidate would', async () => {
    const p = await provisionDemoTenant({ ...VISITOR });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: p.sessionId } });
    expect({ state: session.state, consented: session.recordingConsent, consent: session.consentJson }).toEqual({ state: 'INVITED', consented: false, consent: '{}' });
  });

  it('links the demo role to the catalog data engineering role when the catalog has one', async () => {
    await ensureCatalogSeeded();
    const p = await provisionDemoTenant({ ...VISITOR });
    const role = await prisma.role.findFirstOrThrow({ where: { tenantId: p.tenantId } });
    expect(role.catalogRoleId).not.toBeNull();
  });
});

describe('POST /api/demo/redeem', () => {
  it('signs the visitor in exactly once when two redeems race', async () => {
    const token = await requestAndGetLink();
    const results = await Promise.all([
      request(app).post('/api/demo/redeem').send({ token }),
      request(app).post('/api/demo/redeem').send({ token }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
  });

  it('says a used link was used and offers to ask again', async () => {
    const token = await requestAndGetLink();
    await request(app).post('/api/demo/redeem').send({ token });
    const again = await request(app).post('/api/demo/redeem').send({ token });
    expect({ status: again.status, reason: again.body.reason, canRequestAgain: again.body.canRequestAgain }).toEqual({ status: 410, reason: 'used', canRequestAgain: true });
  });

  it('refuses an expired link', async () => {
    const token = await requestAndGetLink();
    await prisma.demoGrant.updateMany({ data: { linkExpiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post('/api/demo/redeem').send({ token });
    expect(res.body.reason).toBe('expired');
  });

  it('issues a session cookie that lasts at most 45 minutes and restarts the tour', async () => {
    const token = await requestAndGetLink();
    const res = await request(app).post('/api/demo/redeem').send({ token });
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('questor_token='));
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie ?? '')?.[1]);
    expect({ maxAge: maxAge <= 45 * 60 && maxAge > 0, tour: res.body.user.tourCompletedAt }).toEqual({ maxAge: true, tour: null });
  });

  it('reports the demo and its end time on /api/auth/me', async () => {
    const token = await requestAndGetLink();
    const res = await request(app).post('/api/demo/redeem').send({ token });
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect({ isDemo: me.body.tenant.isDemo, ends: typeof me.body.tenant.sessionEndsAt }).toEqual({ isDemo: true, ends: 'string' });
  });

  it('rejects a demo session token once the demo has ended', async () => {
    const token = await requestAndGetLink();
    const res = await request(app).post('/api/demo/redeem').send({ token });
    await prisma.demoGrant.updateMany({ data: { sessionEndsAt: new Date(Date.now() - 1000) } });
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(401);
  });
});

describe('re-access through the operator', () => {
  async function decisionTokenFromOperatorEmail(): Promise<string> {
    const msg = sent.find((m) => m.to === OPERATOR && /decision/.test(`${m.text} ${m.html}`));
    const m = /\/demo\/decision\/([A-Za-z0-9_-]{24,128})/.exec(`${msg?.text ?? ''} ${msg?.html ?? ''}`);
    if (!m) throw new Error('no decision link');
    return m[1];
  }

  it('sends a fresh link when the operator approves, and refuses a second decision', async () => {
    const token = await requestAndGetLink();
    await request(app).post('/api/demo/redeem').send({ token });
    await request(app).post('/api/demo/reaccess').send({ token });
    const decision = await decisionTokenFromOperatorEmail();
    sent.length = 0;

    const approve = await request(app).post(`/api/demo/decision/${decision}`).send({ decision: 'approve' });
    const again = await request(app).post(`/api/demo/decision/${decision}`).send({ decision: 'approve' });

    expect({ approve: approve.status, again: again.status, toVisitor: sent.filter((m) => m.to === VISITOR.email).length }).toEqual({ approve: 200, again: 404, toVisitor: 1 });
  });

  it('emails the visitor when the operator declines', async () => {
    const token = await requestAndGetLink();
    await request(app).post('/api/demo/redeem').send({ token });
    await request(app).post('/api/demo/reaccess').send({ token });
    const decision = await decisionTokenFromOperatorEmail();
    sent.length = 0;

    await request(app).post(`/api/demo/decision/${decision}`).send({ decision: 'decline' });

    expect(sent.map((m) => m.to)).toEqual([VISITOR.email]);
  });
});

describe('demo guardrails', () => {
  async function signedInDemo() {
    const token = await requestAndGetLink();
    const res = await request(app).post('/api/demo/redeem').send({ token });
    return { auth: `Bearer ${res.body.token}`, tenantId: res.body.tenant.id as string };
  }

  it('lets a demo sandbox email only the visitor', async () => {
    const { tenantId } = await signedInDemo();
    expect([await demoRecipientBlocked(tenantId, VISITOR.email), await demoRecipientBlocked(tenantId, 'someone@else.test')]).toEqual([false, true]);
  });

  it('never blocks email for an ordinary organisation', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Real Org' } });
    expect(await demoRecipientBlocked(tenant.id, 'anyone@else.test')).toBe(false);
  });

  it('refuses to send a demo interview invitation to anyone but the visitor', async () => {
    const { auth, tenantId } = await signedInDemo();
    const session = await prisma.interviewSession.findFirstOrThrow({ where: { tenantId } });
    await prisma.candidate.update({ where: { id: session.candidateId }, data: { email: 'victim@else.test' } });
    const res = await request(app).post(`/api/interviews/${session.id}/resend`).set('Authorization', auth);
    expect({ status: res.status, mailedVictim: sent.some((m) => m.to === 'victim@else.test') }).toEqual({ status: 403, mailedVictim: false });
  });

  it('treats a demo interview as heuristic-only so it never spends on a paid model', async () => {
    const p = await provisionDemoTenant({ ...VISITOR });
    const tenant = await prisma.tenant.create({ data: { name: 'Real Org' } });
    expect([await isHeuristicOnlySession(p.sessionId), await isHeuristicOnlySession(`not-${tenant.id}`)]).toEqual([true, false]);
  });

  it('refuses to add roles to the shared catalog from a demo', async () => {
    const { auth } = await signedInDemo();
    await ensureCatalogSeeded();
    const domain = await prisma.catalogDomain.findFirstOrThrow();
    const res = await request(app).post('/api/catalog/roles').set('Authorization', auth).send({ domainId: domain.id, title: 'Demo Only Role' });
    expect(res.status).toBe(403);
  });
});

describe('purgeExpiredDemoTenants', () => {
  it('removes an expired sandbox with its data and leaves ordinary organisations alone', async () => {
    const p = await provisionDemoTenant({ ...VISITOR });
    const real = await prisma.tenant.create({ data: { name: 'Real Org' } });
    await prisma.tenant.update({ where: { id: p.tenantId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } });

    await purgeExpiredDemoTenants();

    const left = await prisma.tenant.findMany({ select: { id: true } });
    expect({ sandboxGone: !left.some((t) => t.id === p.tenantId), realKept: left.some((t) => t.id === real.id), sessions: await prisma.interviewSession.count({ where: { tenantId: p.tenantId } }) }).toEqual({ sandboxGone: true, realKept: true, sessions: 0 });
  });
});

describe('demo interview and role creation', () => {
  async function signedIn() {
    const token = await requestAndGetLink();
    const res = await request(app).post('/api/demo/redeem').send({ token });
    return `Bearer ${res.body.token}`;
  }

  it('gives a signed-in demo the candidate link to its own sample interview', async () => {
    const auth = await signedIn();
    const res = await request(app).get('/api/demo/interview').set('Authorization', auth);
    expect(res.body.portalUrl).toMatch(/\/portal\/[A-Za-z0-9_-]{24,}/);
  });

  it('refuses the sample interview link to an ordinary account', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Real Org' } });
    const user = await prisma.user.create({ data: { tenantId: tenant.id, email: 'hr@real.test', name: 'HR', passwordHash: 'x', role: 'manager' } });
    const { signToken } = await import('../src/services/auth.js');
    const res = await request(app).get('/api/demo/interview').set('Authorization', `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: 'manager', email: user.email })}`);
    expect(res.status).toBe(403);
  });

  it('links a demo role to an existing catalog role but never adds a new title to the shared catalog', async () => {
    const auth = await signedIn();
    await ensureCatalogSeeded();
    const domain = await prisma.catalogDomain.findFirstOrThrow({ where: { roles: { some: {} } } });
    const before = await prisma.catalogRole.count();
    await request(app).post('/api/roles').set('Authorization', auth).send({ sourceType: 'paste', sourceText: 'Zebra Wrangler\nLook after zebras. 3 years.', useLlm: false, title: 'Zebra Wrangler', domainId: domain.id });
    expect(await prisma.catalogRole.count()).toBe(before);
  });
});

describe('POST /api/demo/end', () => {
  it('ends the demo on the server so the session cannot be reused', async () => {
    const token = await requestAndGetLink();
    const res = await request(app).post('/api/demo/redeem').send({ token });
    const auth = `Bearer ${res.body.token}`;

    await request(app).post('/api/demo/end').set('Authorization', auth);

    const me = await request(app).get('/api/auth/me').set('Authorization', auth);
    expect(me.status).toBe(401);
  });
});

describe('demo security review fixes', () => {
  async function redeemed() {
    const token = await requestAndGetLink();
    const res = await request(app).post('/api/demo/redeem').send({ token });
    return res;
  }

  it('stops the sample interview link working once the demo ends', async () => {
    const res = await redeemed();
    const auth = `Bearer ${res.body.token}`;
    const { portalUrl } = (await request(app).get('/api/demo/interview').set('Authorization', auth)).body as { portalUrl: string };
    const portalToken = portalUrl.split('/portal/')[1];

    await request(app).post('/api/demo/end').set('Authorization', auth);

    const portal = await request(app).get(`/api/portal/${portalToken}`);
    expect(portal.status).toBe(410);
  });

  it('does not let a demo interview use paid server speech', async () => {
    const { serverSpeechAllowed } = await import('../src/services/demoPolicy.js');
    const p = await provisionDemoTenant({ ...VISITOR, email: 'speech@acme.test' });
    expect([await serverSpeechAllowed(p.sessionId, () => true), await serverSpeechAllowed('ordinary-session', () => true), await serverSpeechAllowed('ordinary-session', () => false)]).toEqual([false, true, false]);
  });

  it('requires the CSRF header to end a demo from a cookie session', async () => {
    const res = await redeemed();
    const cookies = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const end = await request(app).post('/api/demo/end').set('Cookie', cookies).send({});
    expect(end.status).toBe(403);
  });

  it('creates one sandbox when two requests for the same address race', async () => {
    await Promise.all([requestDemo(), requestDemo()]);
    const live = await prisma.tenant.count({ where: { isDemo: true, demoExpiresAt: { gt: new Date() } } });
    expect({ grants: await prisma.demoGrant.count(), live }).toEqual({ grants: 1, live: 1 });
  });
});
