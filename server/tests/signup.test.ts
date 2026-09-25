import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EmailMessage } from '../src/providers/email/index.js';

const sent: EmailMessage[] = [];
// Set by a test to make the provider fail for matching messages.
const mailFailure = { when: null as ((msg: EmailMessage) => boolean) | null };

vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test',
      configured: true,
      delivers: true,
      send: vi.fn(async (msg: EmailMessage) => {
        if (mailFailure.when?.(msg)) throw new Error('smtp down');
        sent.push(msg);
        return { status: 'sent', id: `test-${sent.length}` };
      }),
    }),
  };
});

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import { hashSignupDecisionToken, mintSignupDecisionToken } from '../src/services/signup.js';
import { runRetentionSweep } from '../src/services/dataRights.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { wipe as wipeAll } from '../src/seed/demoData.js';

const app = createApp();
const PASSWORD = 'correct-horse-battery-staple';

async function wipe() {
  await wipeAll();
}

async function counts() {
  const [tenants, users, signups] = await Promise.all([
    prisma.tenant.count(),
    prisma.user.count(),
    prisma.signupRequest.count(),
  ]);
  return { tenants, users, signups };
}

function signupBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Priya Applicant',
    email: 'priya@example.com',
    password: PASSWORD,
    mode: 'new-org',
    organisationName: 'Priya Labs',
    ...overrides,
  };
}

function decisionTokenFromOperatorMail() {
  const operator = sent.find((m) => m.to === config.signupApproverEmail);
  const match = operator?.text.match(/\/signup\/decision\/([A-Za-z0-9_-]{24,128})/);
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

async function existingTenant(slug = 'acme') {
  return prisma.tenant.create({ data: { name: 'Acme Hiring', slug } });
}

async function adminAuth() {
  const tenant = await prisma.tenant.create({ data: { name: 'Operator Org', slug: 'operator-org' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'operator@example.com', name: 'Operator', passwordHash: hashPassword(PASSWORD), role: 'admin' },
  });
  return `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email: user.email })}`;
}

beforeEach(async () => {
  sent.length = 0;
  mailFailure.when = null;
  config.signupApproverEmail = 'operator@example.com';
  config.webOrigin = 'https://questor.example';
  await wipe();
  // The abuse defences claim each limit atomically as well as counting rows
  // (services/signupAbuse.ts), and a claim outlives a wipe of the tables. Every
  // case below asks from the same address for the same organisation, so without
  // this the fourth one is refused by the third one's allowance.
  _resetRateLimits();
  await prisma.rateLimitBucket.deleteMany();
});

describe('operator-approved signup', () => {
  it('returns the identical public response for a known and an unknown email', async () => {
    await existingTenant();
    await prisma.user.create({
      data: { tenantId: (await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } })).id, email: 'known@example.com', name: 'Known', passwordHash: 'x', role: 'recruiter' },
    });

    const known = await request(app).post('/api/signup').send(signupBody({ email: 'known@example.com' }));
    const unknown = await request(app).post('/api/signup').send(signupBody({ email: 'unknown@example.com' }));

    expect(known.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(known.body).toEqual({ status: 'pending' });
    expect(unknown.body).toEqual({ status: 'pending' });
  });

  it('creates no tenant or user while the request is pending', async () => {
    const before = await counts();

    const res = await request(app).post('/api/signup').send(signupBody());

    expect(res.status).toBe(201);
    expect(await counts()).toEqual({ ...before, signups: before.signups + 1 });
  });

  it('approves a new organisation by creating exactly one tenant and its admin user', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: true });
    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.user.count()).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'priya@example.com' }, include: { tenant: true } });
    expect(user.role).toBe('admin');
    expect(user.tenant.name).toBe('Priya Labs');
    expect(sent.filter((m) => m.to === 'priya@example.com' && m.subject.includes('ready'))).toHaveLength(1);
  });

  it('approves a join request by creating only the recruiter user in the existing tenant', async () => {
    const tenant = await existingTenant('acme');
    await request(app).post('/api/signup').send(signupBody({ mode: 'join', orgCode: 'acme', organisationName: undefined, email: 'joiner@example.com' }));
    const token = decisionTokenFromOperatorMail();

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' });

    expect(res.status).toBe(200);
    expect(await prisma.tenant.count()).toBe(1);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'joiner@example.com' } });
    expect(user.tenantId).toBe(tenant.id);
    expect(user.role).toBe('recruiter');
  });

  it('handles two simultaneous approvals by creating one user and sending one welcome', async () => {
    await request(app).post('/api/signup').send(signupBody({ email: 'race@example.com' }));
    const token = decisionTokenFromOperatorMail();

    const results = await Promise.all([
      request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' }),
      request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' }),
    ]);

    // One click wins; the other learns the decision was already made. Before
    // the 409 fix both reported success, and nobody could tell which had acted.
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.user.count({ where: { email: 'race@example.com' } })).toBe(1);
    expect(await prisma.tenant.count()).toBe(1);
    expect(sent.filter((m) => m.to === 'race@example.com' && m.subject.includes('ready'))).toHaveLength(1);
  });

  it('returns 410 for an expired decision token', async () => {
    const token = mintSignupDecisionToken();
    await prisma.signupRequest.create({
      data: {
        name: 'Expired Applicant', email: 'expired@example.com', mode: 'new-org', organisationName: 'Expired Org',
        passwordHash: hashPassword(PASSWORD), decisionTokenHash: hashSignupDecisionToken(token), expiresAt: new Date(Date.now() - 1000),
      },
    });

    const res = await request(app).get(`/api/signup/decision/${token}`);

    expect(res.status).toBe(410);
    expect(await prisma.signupRequest.findFirstOrThrow({ where: { email: 'expired@example.com' } })).toHaveProperty('status', 'EXPIRED');
  });

  it('returns 404 for a tampered decision token before any database state is revealed', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    const res = await request(app).get(`/api/signup/decision/${tampered}`);

    expect(res.status).toBe(404);
  });

  it('records a decline without creating an account or organisation', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'decline' });

    expect(res.status).toBe(200);
    expect(await prisma.tenant.count()).toBe(0);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.signupRequest.findFirstOrThrow()).toHaveProperty('status', 'DECLINED');
  });

  it('fails closed with 503 when no approver address is configured', async () => {
    config.signupApproverEmail = '';

    const res = await request(app).post('/api/signup').send(signupBody());

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Signup is temporarily unavailable.');
    expect(await prisma.signupRequest.count()).toBe(0);
  });

  it('lets an authenticated admin list and approve pending requests', async () => {
    const auth = await adminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'admin-approve@example.com' }));
    const requestRow = await prisma.signupRequest.findFirstOrThrow({ where: { email: 'admin-approve@example.com' } });

    const listed = await request(app).get('/api/admin/signups?status=pending').set('Authorization', auth);
    expect(listed.status).toBe(200);
    expect(listed.body.signups).toHaveLength(1);
    // Where the applicant's details live, pinned: the queue page reads them
    // from here, and reading them from the top level instead took the page to
    // its error boundary the moment anything was waiting.
    expect(listed.body.signups[0].applicant).toEqual({
      name: 'Priya Applicant',
      email: 'admin-approve@example.com',
      organisation: 'Priya Labs',
      mode: 'new-org',
    });

    const approved = await request(app).post(`/api/admin/signups/${requestRow.id}/approve`).set('Authorization', auth);
    expect(approved.status).toBe(200);
    expect(await prisma.user.count({ where: { email: 'admin-approve@example.com' } })).toBe(1);
  });
});
/**
 * The seams found by reviewing the two independently-built lanes against each
 * other. Each of these either failed, or reported success while doing nothing,
 * before the fix.
 */
describe('a decision that did not happen', () => {
  it('answers 409 rather than reporting success when the request was already decided', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();
    expect((await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' })).status).toBe(200);

    const second = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'decline' });

    expect(second.status).toBe(409);
  });

  it('refuses to decline a request whose link has expired, because approving one is refused too', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const token = decisionTokenFromOperatorMail();
    const row = await prisma.signupRequest.findFirstOrThrow();
    await prisma.signupRequest.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'decline' });

    expect(res.status).toBe(410);
  });
});

describe('what reaches the operator mailbox', () => {
  it('keeps a newline typed into a name out of the mail subject', async () => {
    // Built rather than typed: a literal CR/LF in source survives no round trip
    // through the tools that write these files, and a test whose payload has
    // been quietly flattened proves nothing.
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    await request(app).post('/api/signup').send(signupBody({
      name: `Real Name${CR}${LF}Bcc: someone-else@example.com`,
    }));

    const operator = sent.find((m) => m.to === config.signupApproverEmail);

    expect(operator?.subject).toBeTruthy();
    expect(operator?.subject.includes(CR)).toBe(false);
    expect(operator?.subject.includes(LF)).toBe(false);
  });
});

describe('retention of signup requests', () => {
  const LONG_AGO = () => new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);

  it('deletes a decided request once its window has passed, so no password hash outlives it', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const row = await prisma.signupRequest.findFirstOrThrow();
    await prisma.signupRequest.update({ where: { id: row.id }, data: { status: 'DECLINED', decidedAt: LONG_AGO() } });

    await runRetentionSweep();

    expect(await prisma.signupRequest.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it('never sweeps a request nobody has answered, however old it is', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const row = await prisma.signupRequest.findFirstOrThrow();
    await prisma.signupRequest.update({ where: { id: row.id }, data: { createdAt: LONG_AGO() } });

    await runRetentionSweep();

    expect(await prisma.signupRequest.findUnique({ where: { id: row.id } })).not.toBeNull();
  });
});

/**
 * Found by Codex reviewing a0db550: the link path marks an expired request
 * EXPIRED and answers 410, but the admin path fetched by id and skipped that
 * step, so an operator acting on an expired row from the queue was told it had
 * "already been decided", which it had not. And a request nobody ever opened
 * stayed PENDING forever, password hash included, because retention only swept
 * rows that had reached a final status.
 */
describe('an expired request reached from the operator queue', () => {
  const expire = async (email: string) => {
    const row = await prisma.signupRequest.findFirstOrThrow({ where: { email } });
    await prisma.signupRequest.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    return row;
  };

  it('answers 410 to an admin approving it, not 409', async () => {
    const auth = await adminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'stale-approve@example.com' }));
    const row = await expire('stale-approve@example.com');

    const res = await request(app).post(`/api/admin/signups/${row.id}/approve`).set('Authorization', auth);

    expect(res.status).toBe(410);
  });

  it('answers 410 to an admin declining it, not 409', async () => {
    const auth = await adminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'stale-decline@example.com' }));
    const row = await expire('stale-decline@example.com');

    const res = await request(app).post(`/api/admin/signups/${row.id}/decline`).set('Authorization', auth);

    expect(res.status).toBe(410);
  });

  it('marks the row EXPIRED so it leaves the pending queue', async () => {
    const auth = await adminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'stale-mark@example.com' }));
    const row = await expire('stale-mark@example.com');

    await request(app).post(`/api/admin/signups/${row.id}/approve`).set('Authorization', auth);

    expect(await prisma.signupRequest.findUniqueOrThrow({ where: { id: row.id } })).toHaveProperty('status', 'EXPIRED');
  });
});

describe('retention of a request nobody ever opened', () => {
  it('deletes a still-PENDING request once its link expired longer ago than the retention window', async () => {
    await request(app).post('/api/signup').send(signupBody());
    const row = await prisma.signupRequest.findFirstOrThrow();
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await prisma.signupRequest.update({ where: { id: row.id }, data: { createdAt: longAgo, expiresAt: longAgo } });

    await runRetentionSweep();

    expect(await prisma.signupRequest.findUnique({ where: { id: row.id } })).toBeNull();
  });
});

/**
 * The queue belongs to the deployment operator. admin:manage alone let the
 * admin of any customer read every applicant in the deployment and approve a
 * join request into another customer's organisation.
 */
describe('who may see the operator queue', () => {
  async function tenantAdminAuth() {
    const tenant = await prisma.tenant.create({ data: { name: 'Some Customer', slug: 'some-customer' } });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email: 'admin@some-customer.example', name: 'Customer Admin', passwordHash: hashPassword(PASSWORD), role: 'admin' },
    });
    return `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email: user.email })}`;
  }

  it('refuses a tenant admin who is not the operator', async () => {
    const auth = await tenantAdminAuth();

    const res = await request(app).get('/api/admin/signups?status=pending').set('Authorization', auth);

    expect(res.status).toBe(403);
  });

  it('refuses a tenant admin approving a request', async () => {
    const auth = await tenantAdminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'someone@example.com' }));
    const row = await prisma.signupRequest.findFirstOrThrow();

    const res = await request(app).post(`/api/admin/signups/${row.id}/approve`).set('Authorization', auth);

    expect(res.status).toBe(403);
  });

  it('leaves the request pending after a refused approval', async () => {
    const auth = await tenantAdminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'someone@example.com' }));
    const row = await prisma.signupRequest.findFirstOrThrow();

    await request(app).post(`/api/admin/signups/${row.id}/approve`).set('Authorization', auth);

    expect(await prisma.signupRequest.findUniqueOrThrow({ where: { id: row.id } })).toHaveProperty('status', 'PENDING');
  });

  it('matches the operator address without regard to capitals', async () => {
    config.signupApproverEmail = 'Operator@Example.com';
    const auth = await adminAuth();

    const res = await request(app).get('/api/admin/signups?status=pending').set('Authorization', auth);

    expect(res.status).toBe(200);
  });

  it('fails closed when no operator is configured', async () => {
    const auth = await adminAuth();
    config.signupApproverEmail = '';

    const res = await request(app).get('/api/admin/signups?status=pending').set('Authorization', auth);

    expect(res.status).toBe(503);
  });
});

/**
 * Mail that fails after the database has committed. The account or the request
 * exists either way; what must not happen is the person being told otherwise.
 */
describe('when the mail server is down', () => {
  it('still approves the request when only the welcome email fails', async () => {
    await request(app).post('/api/signup').send(signupBody({ email: 'welcome-fail@example.com' }));
    const token = decisionTokenFromOperatorMail();
    mailFailure.when = (msg) => msg.to === 'welcome-fail@example.com';

    const res = await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' });

    expect(res.status).toBe(200);
  });

  it('does not report "already decided" to an operator whose approval was the one that stuck', async () => {
    await request(app).post('/api/signup').send(signupBody({ email: 'welcome-fail-2@example.com' }));
    const token = decisionTokenFromOperatorMail();
    mailFailure.when = (msg) => msg.to === 'welcome-fail-2@example.com';
    await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'approve' });

    expect(await prisma.user.count({ where: { email: 'welcome-fail-2@example.com' } })).toBe(1);
  });

  it('withdraws the request when the operator could not be told about it, so a retry is clean', async () => {
    mailFailure.when = (msg) => msg.to === config.signupApproverEmail;

    const res = await request(app).post('/api/signup').send(signupBody({ email: 'operator-fail@example.com' }));

    expect([res.status, await prisma.signupRequest.count()]).toEqual([503, 0]);
  });

  it('keeps the request when only the applicant acknowledgement fails', async () => {
    mailFailure.when = (msg) => msg.to === 'ack-fail@example.com';

    const res = await request(app).post('/api/signup').send(signupBody({ email: 'ack-fail@example.com' }));

    expect([res.status, await prisma.signupRequest.count()]).toEqual([201, 1]);
  });
});

describe('the audit trail of a declined new-organisation request', () => {
  it('records the decision against the operator organisation rather than nowhere', async () => {
    await adminAuth();
    await request(app).post('/api/signup').send(signupBody({ email: 'declined-org@example.com', mode: 'new-org', organisationName: 'Nowhere Ltd' }));
    const token = decisionTokenFromOperatorMail();

    await request(app).post(`/api/signup/decision/${token}`).send({ decision: 'decline' });

    const event = await prisma.auditEvent.findFirst({ where: { action: 'signup.declined' } });
    expect(event).not.toBeNull();
  });
});
