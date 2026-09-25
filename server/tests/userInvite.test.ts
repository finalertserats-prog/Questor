import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import { _resetEmail, type EmailMessage } from '../src/providers/email/index.js';
import { hashInviteToken, INVITE_TTL_MS, purgeEndedInvites } from '../src/services/userInvite.js';
import { logger } from '../src/logger.js';

/**
 * Adding a colleague, as an emailed invitation.
 *
 * The property being defended is narrow and easy to lose: nobody but the
 * invited person ever knows their password. An admin who could set it could
 * sign in as them, and every action that account took would be unattributable —
 * which would hollow out the SME review, whose entire content is "this named
 * expert recommended this".
 *
 * So the assertions come in two kinds. That the flow works, and that the token
 * is not anywhere it should not be: not in the create response, not in the
 * pending list, not in the audit row, and not in the database in a form that
 * could be replayed.
 */

interface Sent { to: string; subject: string; text: string; html: string }
let outbox: Sent[] = [];
/** Set for one send, to stand in for a mail server that is down. */
let sendFailsOnce = false;

const captureProvider = {
  name: 'capture',
  configured: true,
  delivers: true,
  send: async (msg: EmailMessage) => {
    if (sendFailsOnce) { sendFailsOnce = false; throw new Error('the mail server is down'); }
    outbox.push({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return { status: 'sent', id: String(outbox.length) };
  },
};

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return { ...actual, getEmail: () => captureProvider };
});

const app = createApp();

const FIXTURE_PASSPHRASE = 'not-a-real-passphrase-fixture';
// Comfortably over PASSWORD_MIN_LENGTH; what the invited colleague chooses.
const CHOSEN = 'ferry-lantern-quay-19';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let adminToken = '';
let recruiterToken = '';

/**
 * The token out of the newest invitation mail.
 *
 * Only the test suite ever does this, and it is the one place in the codebase
 * that reads a live invitation token: it exists nowhere else but in the
 * recipient's inbox, which is the point.
 */
function linkToken(): string {
  const mail = [...outbox].reverse().find((m) => m.subject.startsWith('You have been invited'));
  if (!mail) throw new Error('no invitation email was sent');
  const m = /\/accept-invite#([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!m) throw new Error('invitation email carried no link');
  return m[1];
}

beforeAll(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Invite Org' } });
  tenantId = tenant.id;

  const admin = await prisma.user.create({
    data: { tenantId, email: 'admin@invite.test', name: 'Ada Admin', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'admin' },
  });
  adminToken = signToken({ userId: admin.id, tenantId, role: 'admin', email: admin.email });

  const recruiter = await prisma.user.create({
    data: { tenantId, email: 'recruiter@invite.test', name: 'Rex Recruiter', passwordHash: hashPassword(FIXTURE_PASSPHRASE), role: 'recruiter' },
  });
  recruiterToken = signToken({ userId: recruiter.id, tenantId, role: 'recruiter', email: recruiter.email });
});

beforeEach(async () => {
  outbox = [];
  sendFailsOnce = false;
  await prisma.userInvite.deleteMany();
  await prisma.user.deleteMany({ where: { tenantId, email: { contains: '@joining.test' } } });
  // Cleared per case so the audit assertion below reads the row this case
  // wrote rather than everything the file has done so far.
  await prisma.auditEvent.deleteMany();
});

afterAll(() => { _resetEmail(); });

const invite = (body: Record<string, unknown>, token = adminToken) => request(app)
  .post('/api/admin/invites').set(auth(token)).send(body);

const SME_INVITE = { name: 'Sanjay Expert', email: 'sanjay@joining.test', role: 'sme' };

describe('sending an invitation', () => {
  it('mails a link to the address the admin named', async () => {
    const res = await invite(SME_INVITE);

    expect(res.status).toBe(201);
    expect(outbox.at(-1)?.to).toBe('sanjay@joining.test');
  });

  it('creates no account until the link is used', async () => {
    await invite(SME_INVITE);

    expect(await prisma.user.count({ where: { email: 'sanjay@joining.test' } })).toBe(0);
  });

  it('records the role the admin chose', async () => {
    await invite(SME_INVITE);

    expect((await prisma.userInvite.findFirstOrThrow()).role).toBe('sme');
  });

  it('refuses a role outside the fixed set', async () => {
    expect((await invite({ ...SME_INVITE, role: 'superuser' })).status).toBe(400);
  });

  it('refuses an address that already has an account', async () => {
    expect((await invite({ ...SME_INVITE, email: 'recruiter@invite.test' })).status).toBe(409);
  });

  it('denies a recruiter the ability to invite', async () => {
    expect((await invite(SME_INVITE, recruiterToken)).status).toBe(403);
  });

  it('rejects an unauthenticated caller', async () => {
    expect((await request(app).post('/api/admin/invites').send(SME_INVITE)).status).toBe(401);
  });

  // An invitation nobody received is a live credential sitting in the database
  // that its holder cannot use and its author does not know exists — and the
  // admin is about to be told it failed, so a pending row would make the list
  // lie as well.
  it('withdraws the invitation when the mail could not be sent', async () => {
    sendFailsOnce = true;

    const res = await invite(SME_INVITE);

    expect(res.status).toBe(503);
    expect(await prisma.userInvite.count()).toBe(0);
  });

  // Two live links for one address would both work, and revoking would mean
  // finding all of them — done right until the day it matters.
  it('replaces a standing invitation rather than adding a second', async () => {
    await invite(SME_INVITE);
    await invite({ ...SME_INVITE, role: 'reviewer' });

    const rows = await prisma.userInvite.findMany({ where: { email: 'sanjay@joining.test' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('reviewer');
  });

  it('retires the first link when a second is sent', async () => {
    await invite(SME_INVITE);
    const first = linkToken();
    await invite(SME_INVITE);

    const res = await request(app).post('/api/auth/invite/check').send({ token: first });
    expect(res.body.usable).toBe(false);
  });
});

describe('the token goes nowhere but the mailbox', () => {
  it('is not in the response the admin receives', async () => {
    await invite(SME_INVITE);
    const token = linkToken();

    const res = await invite({ ...SME_INVITE, email: 'other@joining.test' });
    expect(JSON.stringify(res.body)).not.toContain(token);
  });

  it('is not in the pending list', async () => {
    await invite(SME_INVITE);
    const token = linkToken();

    const res = await request(app).get('/api/admin/invites').set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(res.body.invites[0].tokenHash).toBeUndefined();
  });

  it('is not in the audit record of the invitation', async () => {
    await invite(SME_INVITE);
    const token = linkToken();

    const events = await prisma.auditEvent.findMany({ where: { action: 'user.invited' } });
    expect(events).toHaveLength(1);
    expect(`${events[0].beforeJson}${events[0].afterJson}`).not.toContain(token);
  });

  // The stored form is an HMAC under the server pepper, so a copy of the table
  // is not a pile of working invitations. The assertion is that the column is
  // not the token, in any recognisable form.
  it('is not stored in a form that could be replayed', async () => {
    await invite(SME_INVITE);
    const token = linkToken();

    const row = await prisma.userInvite.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).not.toContain(token);
    // ...and the stored value IS the peppered hash of that token, so the check
    // on acceptance is comparing the right two things.
    expect(row.tokenHash).toBe(hashInviteToken(token));
  });

  // The fragment is never sent to a server, so the token cannot reach an access
  // log, a Referer header or a proxy's request record.
  it('puts the token in the link fragment rather than the path', async () => {
    await invite(SME_INVITE);

    expect(outbox.at(-1)?.text).toContain('/accept-invite#');
  });
});

describe('a send that fails', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * The one plausible way a live invitation token reaches a log file.
   *
   * An HTTP client that rejects a request commonly puts the request body it
   * rejected into the error it throws — and the body we handed it is the email,
   * which carries the link. So the provider's own error text is the one thing
   * this failure path must not log, however useful it would be.
   */
  it('does not write the token into the log when the provider throws it back', async () => {
    await invite(SME_INVITE);
    const token = linkToken();
    await prisma.userInvite.deleteMany();
    outbox = [];

    const calls: unknown[][] = [];
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { calls.push(args); }) as never);
    }
    // A provider whose error quotes back the message it refused, link and all.
    const rejecting = vi.spyOn(captureProvider, 'send').mockImplementation(async (msg: EmailMessage) => {
      throw new Error(`422 rejected payload: ${JSON.stringify(msg)}`);
    });

    const res = await invite({ ...SME_INVITE, email: 'rejected@joining.test' });

    expect(res.status).toBe(503);
    const written = JSON.stringify(calls);
    expect(written).not.toContain('/accept-invite#');
    // Belt and braces: the first invitation's token is a real one of the same
    // shape, and nothing about a failed send should print a token at all.
    expect(written).not.toContain(token);
    rejecting.mockRestore();
  });
});

describe('two invitations at once', () => {
  // Two live links for one address would both work, and withdrawing "the"
  // invitation would then retire one and quietly leave the other standing.
  it('leave exactly one working link', async () => {
    const both = await Promise.all([invite(SME_INVITE), invite(SME_INVITE)]);

    // One of the two may lose at the database (409) rather than be sent; what
    // must never happen is two rows.
    expect(both.every((res) => res.status === 201 || res.status === 409)).toBe(true);
    expect(await prisma.userInvite.count({ where: { email: 'sanjay@joining.test' } })).toBe(1);
  });

  it('leave a link that still works', async () => {
    await Promise.all([invite(SME_INVITE), invite(SME_INVITE)]);

    const res = await request(app).post('/api/auth/invite/check').send({ token: linkToken() });

    expect(res.body.usable).toBe(true);
  });
});

describe('accepting an invitation', () => {
  const accept = (token: string, password: string) => request(app)
    .post('/api/auth/invite/accept').send({ token, password });

  it('tells the page who the invitation is for, without consuming it', async () => {
    await invite(SME_INVITE);
    const token = linkToken();

    const first = await request(app).post('/api/auth/invite/check').send({ token });
    const second = await request(app).post('/api/auth/invite/check').send({ token });

    expect([first.body.usable, second.body.usable]).toEqual([true, true]);
    expect(first.body.name).toBe('Sanjay Expert');
  });

  it('creates the account with the role the admin chose', async () => {
    await invite(SME_INVITE);

    const res = await accept(linkToken(), CHOSEN);

    expect(res.status).toBe(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'sanjay@joining.test' } });
    expect([user.role, user.tenantId, user.name]).toEqual(['sme', tenantId, 'Sanjay Expert']);
  });

  it('lets them sign in with the password they chose, and nobody else\'s', async () => {
    await invite(SME_INVITE);
    await accept(linkToken(), CHOSEN);

    const res = await request(app).post('/api/auth/login').send({ email: 'sanjay@joining.test', password: CHOSEN });

    expect(res.status).toBeLessThan(400);
  });

  // Following a link proves control of a mailbox, not of the account. The
  // sign-in that follows is what the audit trail, the login limiter and the
  // sign-in code step are built around — and an invitation intercepted in
  // transit therefore still cannot be turned straight into a live session.
  it('issues no session', async () => {
    await invite(SME_INVITE);

    const res = await accept(linkToken(), CHOSEN);

    expect(res.body.token).toBeUndefined();
  });

  it('works once', async () => {
    await invite(SME_INVITE);
    const token = linkToken();
    await accept(token, CHOSEN);

    const again = await accept(token, 'another-quay-lantern-21');

    expect(again.status).toBe(400);
    expect(await prisma.user.count({ where: { email: 'sanjay@joining.test' } })).toBe(1);
  });

  // The person would otherwise be told "too short", press back, and find the
  // invitation spent.
  it('does not burn the invitation on a password that is too weak', async () => {
    await invite(SME_INVITE);
    const token = linkToken();

    const weak = await accept(token, 'short');
    const good = await accept(token, CHOSEN);

    expect([weak.status, good.status]).toEqual([400, 200]);
  });

  it('refuses an expired invitation', async () => {
    await invite(SME_INVITE);
    const token = linkToken();
    await prisma.userInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await accept(token, CHOSEN)).status).toBe(400);
  });

  it('refuses an invitation the admin withdrew', async () => {
    await invite(SME_INVITE);
    const token = linkToken();
    const row = await prisma.userInvite.findFirstOrThrow();
    await request(app).delete(`/api/admin/invites/${row.id}`).set(auth(adminToken));

    expect((await accept(token, CHOSEN)).status).toBe(400);
  });

  it('refuses an invented token', async () => {
    expect((await accept('a'.repeat(43), CHOSEN)).status).toBe(400);
  });

  // An expired link, a withdrawn one and one that never existed all get the
  // same sentence: telling them apart would turn guessing at tokens into
  // confirming that an address was once invited.
  it('says the same thing however the link is dead', async () => {
    await invite(SME_INVITE);
    const token = linkToken();
    await prisma.userInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const expired = await accept(token, CHOSEN);
    const invented = await accept('b'.repeat(43), CHOSEN);

    expect(expired.body.error).toBe(invented.body.error);
  });

  it('answers a spent invitation the way it answers an invented one', async () => {
    await invite(SME_INVITE);
    const token = linkToken();
    await accept(token, CHOSEN);

    const spent = await request(app).post('/api/auth/invite/check').send({ token });
    const invented = await request(app).post('/api/auth/invite/check').send({ token: 'c'.repeat(43) });

    expect(spent.body).toEqual(invented.body);
  });
});

describe('the pending list', () => {
  it('shows who is still to join', async () => {
    await invite(SME_INVITE);

    const res = await request(app).get('/api/admin/invites').set(auth(adminToken));

    expect(res.body.invites.map((i: { email: string }) => i.email)).toEqual(['sanjay@joining.test']);
  });

  it('drops someone once they have joined', async () => {
    await invite(SME_INVITE);
    await request(app).post('/api/auth/invite/accept').send({ token: linkToken(), password: CHOSEN });

    const res = await request(app).get('/api/admin/invites').set(auth(adminToken));

    expect(res.body.invites).toEqual([]);
  });

  it('marks one that has run out rather than hiding it', async () => {
    await invite(SME_INVITE);
    await prisma.userInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).get('/api/admin/invites').set(auth(adminToken));

    expect(res.body.invites[0].expired).toBe(true);
  });

  it('denies a recruiter the list', async () => {
    expect((await request(app).get('/api/admin/invites').set(auth(recruiterToken))).status).toBe(403);
  });

  it('reports withdrawing an invitation that is not there as not found', async () => {
    const res = await request(app).delete('/api/admin/invites/no-such-invite').set(auth(adminToken));

    expect(res.status).toBe(404);
  });
});

describe('the purge', () => {
  it('leaves a live invitation alone', async () => {
    await invite(SME_INVITE);

    await purgeEndedInvites();

    expect(await prisma.userInvite.count()).toBe(1);
  });

  // An hour's grace after expiry, matching the reset purge, so a person
  // following a link that has just run out is told "this has expired" rather
  // than "this never existed".
  it('leaves one that expired in the last hour alone', async () => {
    await invite(SME_INVITE);
    await prisma.userInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 60_000) } });

    await purgeEndedInvites();

    expect(await prisma.userInvite.count()).toBe(1);
  });

  it('clears one that ran out long ago', async () => {
    await invite(SME_INVITE);
    await prisma.userInvite.updateMany({ data: { expiresAt: new Date(Date.now() - INVITE_TTL_MS) } });

    await purgeEndedInvites();

    expect(await prisma.userInvite.count()).toBe(0);
  });

  it('clears one that was accepted long ago', async () => {
    await invite(SME_INVITE);
    await prisma.userInvite.updateMany({ data: { acceptedAt: new Date(Date.now() - 24 * 60 * 60_000) } });

    await purgeEndedInvites();

    expect(await prisma.userInvite.count()).toBe(0);
  });
});
