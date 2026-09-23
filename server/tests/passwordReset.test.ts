import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { hashPassword, signToken, verifyPassword } from '../src/services/auth.js';
import { _resetEmail } from '../src/providers/email/index.js';
import {
  settlePasswordResets, hashResetToken, RESET_TTL_MS, RESEND_COOLDOWN_MS, MAX_RESETS_PER_HOUR,
  requestPasswordReset, completePasswordReset, changeOwnPassword, purgeEndedResetTokens,
} from '../src/services/passwordReset.js';
import type { EmailMessage } from '../src/providers/email/index.js';

// Forgot password, set a new one, change your own, and an admin sending a
// colleague a link. The security properties each have a named test below:
// enumeration, single use, session invalidation, escalation, tenancy.

const app = createApp();

const GOOD = 'a-long-enough-passphrase';
const ANOTHER = 'another-long-enough-phrase';

interface Sent { to: string; subject: string; text: string; html: string }
let outbox: Sent[] = [];
/** Set for one send, to stand in for a mail server that is down. */
let sendFailsOnce = false;

// The console provider is what the suite runs with; it logs and delivers
// nothing, so the mails are captured here instead. Capturing them is the only
// way to get hold of a link — nothing else in the app ever exposes a token.
// One provider object, not a fresh one per call: a test that wants a failing
// send has to be able to reach the same object the code under test reached.
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
  return {
    ...actual,
    getEmail: () => captureProvider,
  };
});

interface Fx {
  tenantId: string;
  otherTenantId: string;
  userId: string;
  userEmail: string;
  adminId: string;
  adminToken: string;
  recruiterToken: string;
  foreignAdminToken: string;
  foreignUserId: string;
}
let fx: Fx;

/** The token out of the newest reset mail. Only the test suite ever does this. */
function linkToken(): string {
  const mail = [...outbox].reverse().find((m) => m.subject.startsWith('Set a new Questor password'));
  if (!mail) throw new Error('no reset email was sent');
  const m = /\/reset-password#([A-Za-z0-9_-]+)/.exec(mail.text);
  if (!m) throw new Error('reset email carried no link');
  return m[1];
}

const forgot = (email: string) => request(app).post('/api/auth/password/forgot').send({ email });
const reset = (token: string, password: string) => request(app).post('/api/auth/password/reset').send({ token, password });
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password });

beforeAll(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Reset Org' } });
  const other = await prisma.tenant.create({ data: { name: 'Other Reset Org' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: 'rita@reset.local', name: 'Rita Recruiter', passwordHash: hashPassword(GOOD), role: 'recruiter' } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, email: 'asha@reset.local', name: 'Asha Admin', passwordHash: hashPassword(GOOD), role: 'admin' } });
  const foreignAdmin = await prisma.user.create({ data: { tenantId: other.id, email: 'far@other.local', name: 'Far Admin', passwordHash: hashPassword(GOOD), role: 'admin' } });
  const foreignUser = await prisma.user.create({ data: { tenantId: other.id, email: 'fu@other.local', name: 'Foreign User', passwordHash: hashPassword(GOOD), role: 'recruiter' } });
  fx = {
    tenantId: tenant.id, otherTenantId: other.id,
    userId: user.id, userEmail: user.email, adminId: admin.id,
    adminToken: signToken({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: admin.email }),
    recruiterToken: signToken({ userId: user.id, tenantId: tenant.id, role: 'recruiter', email: user.email }),
    foreignAdminToken: signToken({ userId: foreignAdmin.id, tenantId: other.id, role: 'admin', email: foreignAdmin.email }),
    foreignUserId: foreignUser.id,
  };
});

beforeEach(async () => {
  outbox = [];
  sendFailsOnce = false;
  await prisma.passwordResetToken.deleteMany({});
  await prisma.auditEvent.deleteMany({});
  await prisma.user.update({ where: { id: fx.userId }, data: { passwordHash: hashPassword(GOOD), sessionsEpoch: 0 } });
});

afterAll(() => { _resetEmail(); });

describe('asking for a reset link', () => {
  it('emails a link to an address that has an account', async () => {
    const res = await forgot(fx.userEmail);
    await settlePasswordResets();

    expect(res.status).toBe(202);
    expect(outbox.map((m) => m.to)).toEqual([fx.userEmail]);
    expect(linkToken().length).toBeGreaterThan(20);
  });

  it('answers an address with no account exactly as it answers one with an account', async () => {
    const known = await forgot(fx.userEmail);
    await settlePasswordResets();
    outbox = [];
    const unknown = await forgot('nobody-at-all@reset.local');
    await settlePasswordResets();

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(outbox).toEqual([]);
  });

  it('never says whether an address exists in the words it uses', async () => {
    const res = await forgot('nobody-at-all@reset.local');
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('not found');
    expect(JSON.stringify(res.body)).toContain('If that address has a Questor account');
  });

  it('retires an earlier link when a newer one is asked for', async () => {
    const first = await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, new Date(Date.now() - RESEND_COOLDOWN_MS - 1000));
    expect(first.kind).toBe('sent');
    const firstToken = linkToken();
    const second = await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    expect(second.kind).toBe('sent');
    const secondToken = linkToken();
    expect(secondToken).not.toBe(firstToken);

    expect(await reset(firstToken, ANOTHER).then((r) => r.status)).toBe(400);
    expect(await reset(secondToken, ANOTHER).then((r) => r.status)).toBe(200);
  });

  it('makes a second request wait out a cooldown', async () => {
    expect((await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' })).kind).toBe('sent');
    expect(await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' })).toEqual({ kind: 'wait', reason: 'cooldown' });
  });

  it('stops after an hourly ceiling however patient the caller is', async () => {
    const base = Date.now() - 30 * 60_000;
    for (let i = 0; i < MAX_RESETS_PER_HOUR; i += 1) {
      const at = new Date(base + i * (RESEND_COOLDOWN_MS + 1000));
      expect((await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, at)).kind).toBe('sent');
    }
    const after = new Date(base + MAX_RESETS_PER_HOUR * (RESEND_COOLDOWN_MS + 1000));
    expect(await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, after)).toEqual({ kind: 'wait', reason: 'hourly' });
  });

  it('holds nothing against the next try when the email could not be sent', async () => {
    sendFailsOnce = true;
    expect(await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' })).toEqual({ kind: 'not_delivered' });

    expect(await prisma.passwordResetToken.count({ where: { userId: fx.userId } })).toBe(0);
    expect((await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' })).kind).toBe('sent');
  });
});

describe('the stored token', () => {
  it('is never the token itself', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const token = linkToken();
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: fx.userId } });

    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(token);
    expect(rows[0].tokenHash).toBe(hashResetToken(token));
    // A hex SHA-256, not the base64url token.
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries at least 128 bits of randomness', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(Date.now() - (5 - i) * (RESEND_COOLDOWN_MS + 1000));
      await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, at);
      tokens.add(linkToken());
    }
    expect(tokens.size).toBe(5);
    // base64url: 4 characters carry 3 bytes. 22 characters is already 128 bits.
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43);
  });

  it('expires', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, new Date(Date.now() - RESET_TTL_MS - 1000));
    const res = await reset(linkToken(), ANOTHER);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no longer valid');
  });

  it('is swept away once it has been dead for an hour', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, new Date(Date.now() - 3 * 60 * 60_000));
    expect(await purgeEndedResetTokens()).toBe(1);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });
});

describe('setting a new password from a link', () => {
  it('lets the person sign in with the new password and refuses the old one', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    expect((await reset(linkToken(), ANOTHER)).status).toBe(200);

    expect((await login(fx.userEmail, ANOTHER)).status).toBe(200);
    expect((await login(fx.userEmail, GOOD)).status).toBe(401);
  });

  it('cannot be used twice', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const token = linkToken();
    expect((await reset(token, ANOTHER)).status).toBe(200);

    const second = await reset(token, 'a-third-long-passphrase');
    expect(second.status).toBe(400);
    expect(second.body.error).toContain('no longer valid');
    // And the second attempt did not quietly take effect.
    expect((await login(fx.userEmail, ANOTHER)).status).toBe(200);
  });

  it('lets exactly one of two simultaneous presses through', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const token = linkToken();
    const results = await Promise.all([
      completePasswordReset(token, ANOTHER, { ip: '1.2.3.4' }),
      completePasswordReset(token, 'a-third-long-passphrase', { ip: '1.2.3.4' }),
    ]);
    expect(results.filter((r) => r.kind === 'done')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'invalid')).toHaveLength(1);
  });

  it('holds the new password to the same rule the signup path applies', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const res = await reset(linkToken(), 'short');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at least 12 characters');
  });

  it('answers an invented link exactly as it answers an expired one', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, new Date(Date.now() - RESET_TTL_MS - 1000));
    const expired = await reset(linkToken(), ANOTHER);
    const invented = await reset('this-token-was-never-issued-at-all', ANOTHER);

    expect(invented.status).toBe(expired.status);
    // requestId differs per request by design; everything a caller could read
    // an answer out of must not.
    const { requestId: _a, ...inventedBody } = invented.body as Record<string, unknown>;
    const { requestId: _b, ...expiredBody } = expired.body as Record<string, unknown>;
    expect(inventedBody).toEqual(expiredBody);
  });

  it('does not hand back a session', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const res = await reset(linkToken(), ANOTHER);
    const cookies = String(res.headers['set-cookie'] ?? '');

    expect(res.body.token).toBeUndefined();
    // The only cookie work here is clearing, never setting a live session.
    expect(cookies).not.toMatch(/questor_token=[A-Za-z0-9]/);
  });

  it('changes the password and nothing else', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: fx.userId } });
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    await reset(linkToken(), ANOTHER);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: fx.userId } });

    expect(after.role).toBe(before.role);
    expect(after.tenantId).toBe(before.tenantId);
    expect(after.email).toBe(before.email);
    expect(after.passwordHash).not.toBe(before.passwordHash);
  });

  it('fails cleanly when the account has gone', async () => {
    const doomed = await prisma.user.create({ data: { tenantId: fx.tenantId, email: 'gone@reset.local', name: 'Gone', passwordHash: hashPassword(GOOD), role: 'recruiter' } });
    await requestPasswordReset(doomed.email, { ip: '1.2.3.4' });
    const token = linkToken();
    await prisma.user.delete({ where: { id: doomed.id } });

    const res = await reset(token, ANOTHER);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no longer valid');
  });

  it('refuses a demo visitor, and says nothing different about it', async () => {
    const demoTenant = await prisma.tenant.create({ data: { name: 'Sandbox', isDemo: true } });
    const visitor = await prisma.user.create({ data: { tenantId: demoTenant.id, email: 'visitor@demo.local', name: 'Visitor', passwordHash: hashPassword(GOOD), role: 'demo' } });

    const res = await forgot(visitor.email);
    await settlePasswordResets();
    expect(res.status).toBe(202);
    expect(outbox).toEqual([]);
    expect(await prisma.passwordResetToken.count({ where: { userId: visitor.id } })).toBe(0);
  });
});

describe('the link check', () => {
  it('says a live link is usable and a dead one is not, without naming anyone', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const live = await request(app).post('/api/auth/password/reset/check').send({ token: linkToken() });
    expect(live.status).toBe(200);
    expect(live.body.usable).toBe(true);
    expect(JSON.stringify(live.body)).not.toContain(fx.userEmail);

    const dead = await request(app).post('/api/auth/password/reset/check').send({ token: 'never-issued-token-value' });
    expect(dead.status).toBe(200);
    expect(dead.body.usable).toBe(false);
  });
});

describe('changing your own password', () => {
  const change = (token: string, currentPassword: string, newPassword: string) =>
    request(app).post('/api/auth/password/change').set('Authorization', `Bearer ${token}`).send({ currentPassword, newPassword });

  it('needs the current password', async () => {
    const res = await change(fx.recruiterToken, 'not-the-current-one', ANOTHER);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not your current password');
    expect(verifyPassword(GOOD, (await prisma.user.findUniqueOrThrow({ where: { id: fx.userId } })).passwordHash)).toBe(true);
  });

  it('refuses the password the account already has', async () => {
    const res = await change(fx.recruiterToken, GOOD, GOOD);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('different from your current one');
  });

  it('holds the new password to the shared rule', async () => {
    const res = await change(fx.recruiterToken, GOOD, 'short');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('at least 12 characters');
  });

  it('changes it, and signs the person in with it', async () => {
    expect((await change(fx.recruiterToken, GOOD, ANOTHER)).status).toBe(200);
    expect((await login(fx.userEmail, ANOTHER)).status).toBe(200);
    expect((await login(fx.userEmail, GOOD)).status).toBe(401);
  });

  it('records a failed attempt', async () => {
    await change(fx.recruiterToken, 'not-the-current-one', ANOTHER);
    const events = await prisma.auditEvent.findMany({ where: { action: 'password.change_failed' } });
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(fx.userId);
  });

  it('is refused without a CSRF header when the caller is a browser', async () => {
    // A cookie session with no matching header is exactly a forged request.
    const res = await request(app)
      .post('/api/auth/password/change')
      .set('Cookie', [`questor_token=${fx.recruiterToken}`, 'questor_csrf=some-value'])
      .send({ currentPassword: GOOD, newPassword: ANOTHER });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('CSRF');
  });
});

describe('sessions', () => {
  it('ends every other session a reset touches', async () => {
    const elsewhere = signToken({ userId: fx.userId, tenantId: fx.tenantId, role: 'recruiter', email: fx.userEmail, pv: 0 });
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${elsewhere}`)).status).toBe(200);

    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    await reset(linkToken(), ANOTHER);

    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${elsewhere}`)).status).toBe(401);
  });

  it('ends other sessions on a change but keeps the one that made it', async () => {
    const elsewhere = signToken({ userId: fx.userId, tenantId: fx.tenantId, role: 'recruiter', email: fx.userEmail, pv: 0 });
    const res = await request(app).post('/api/auth/password/change')
      .set('Authorization', `Bearer ${fx.recruiterToken}`)
      .send({ currentPassword: GOOD, newPassword: ANOTHER });
    expect(res.status).toBe(200);

    // The reply carries a fresh cookie, and that one still works.
    const issued = String(res.headers['set-cookie'] ?? '');
    const fresh = /questor_token=([^;]+)/.exec(issued)?.[1] ?? '';
    expect(fresh).not.toBe('');
    expect((await request(app).get('/api/auth/me').set('Cookie', [`questor_token=${fresh}`])).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${elsewhere}`)).status).toBe(401);
  });

  it('kills a link that was outstanding when the owner changed their password', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const token = linkToken();
    expect((await changeOwnPassword(fx.userId, GOOD, ANOTHER, { ip: '1.2.3.4' })).kind).toBe('done');

    expect((await reset(token, 'a-third-long-passphrase')).status).toBe(400);
  });
});

describe('the notification', () => {
  it('tells the account holder their password moved, with no secret in it', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const token = linkToken();
    outbox = [];
    await reset(token, ANOTHER);

    const note = outbox.find((m) => m.subject === 'Your Questor password was changed');
    expect(note?.to).toBe(fx.userEmail);
    expect(note?.text).not.toContain(token);
    expect(note?.text).not.toContain(ANOTHER);
    expect(note?.html).not.toContain(token);
    expect(note?.text).toContain('signed out');
  });

  it('is sent for a change too', async () => {
    await changeOwnPassword(fx.userId, GOOD, ANOTHER, { ip: '1.2.3.4' });
    const note = outbox.find((m) => m.subject === 'Your Questor password was changed');
    expect(note?.to).toBe(fx.userEmail);
    expect(note?.text).not.toContain(ANOTHER);
  });

  it('never puts the token or the password in the reset mail beyond the link', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' });
    const mail = outbox[0];
    const token = linkToken();
    // The token appears only inside the link's fragment, twice: the button's
    // href and the plain-text copy underneath it for clients that strip links.
    expect(mail.text.split(token).length - 1).toBe(1);
    expect(mail.text).toContain(`/reset-password#${token}`);
    expect(mail.text).not.toContain(GOOD);
  });
});

describe('the audit trail', () => {
  const actions = async () => (await prisma.auditEvent.findMany({ orderBy: { createdAt: 'asc' } })).map((e) => e.action);

  it('records the request and the completion, with who and from where', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '203.0.113.7' });
    const token = linkToken();
    await reset(token, ANOTHER);

    expect(await actions()).toEqual(['password.reset_requested', 'password.reset_completed']);
    const events = await prisma.auditEvent.findMany();
    for (const e of events) {
      expect(e.entityId).toBe(fx.userId);
      expect(e.tenantId).toBe(fx.tenantId);
      expect(e.afterJson).not.toContain(token);
      expect(e.afterJson).not.toContain(ANOTHER);
    }
    expect(events[0].afterJson).toContain('203.0.113.7');
  });

  it('records a link that did not work, against the account it was for', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '203.0.113.7' }, new Date(Date.now() - RESET_TTL_MS - 1000));
    await reset(linkToken(), ANOTHER);

    const failed = await prisma.auditEvent.findMany({ where: { action: 'password.reset_failed' } });
    expect(failed).toHaveLength(1);
    expect(failed[0].entityId).toBe(fx.userId);
    expect(failed[0].afterJson).toContain('expired');
  });

  it('writes nothing down for a link nobody ever issued', async () => {
    await reset('a-token-that-was-never-issued-at-all', ANOTHER);
    // Recording it would mean storing whatever a stranger typed, against a
    // tenant we would have to guess at.
    expect(await prisma.auditEvent.count()).toBe(0);
  });

  it('records a change', async () => {
    await changeOwnPassword(fx.userId, GOOD, ANOTHER, { ip: '203.0.113.7' });
    expect(await actions()).toEqual(['password.changed']);
  });
});

describe('an admin sending a colleague a link', () => {
  const adminSend = (token: string, userId: string) =>
    request(app).post(`/api/admin/users/${userId}/password-reset`).set('Authorization', `Bearer ${token}`).send({});

  it('mails the link to the colleague, never to the admin', async () => {
    const res = await adminSend(fx.adminToken, fx.userId);
    await settlePasswordResets();

    expect(res.status).toBe(202);
    expect(outbox.map((m) => m.to)).toEqual([fx.userEmail]);
    // And the admin is told nothing that would let them use it.
    expect(JSON.stringify(res.body)).not.toContain(linkToken());
  });

  it('tells the admin what actually happened, rather than always "on its way"', async () => {
    // No enumeration question here — the admin is looking at the row — and the
    // cooldown is shared with the colleague's own "Forgot password", so
    // "nothing was sent" is a thing an admin needs to be told.
    await adminSend(fx.adminToken, fx.userId);
    await settlePasswordResets();
    outbox = [];

    const second = await adminSend(fx.adminToken, fx.userId);
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(false);
    expect(second.body.outcome).toBe('wait');
    expect(second.body.message).toContain('in the last minute');
    expect(outbox).toEqual([]);
  });

  it('says so when the mail could not go, rather than claiming it did', async () => {
    sendFailsOnce = true;
    const res = await adminSend(fx.adminToken, fx.userId);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toContain('Nothing was sent');
  });

  it('leaves a link the colleague already holds alone when a send fails', async () => {
    await requestPasswordReset(fx.userEmail, { ip: '1.2.3.4' }, new Date(Date.now() - RESEND_COOLDOWN_MS - 1000));
    const held = linkToken();

    sendFailsOnce = true;
    expect((await adminSend(fx.adminToken, fx.userId)).body.ok).toBe(false);

    // The attempt that failed to replace it must not have killed it.
    expect((await reset(held, ANOTHER)).status).toBe(200);
  });

  it('is recorded as an admin having sent it', async () => {
    await adminSend(fx.adminToken, fx.userId);
    await settlePasswordResets();
    const events = await prisma.auditEvent.findMany({ where: { action: 'password.reset_sent_by_admin' } });

    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBe(fx.adminId);
    expect(events[0].entityId).toBe(fx.userId);
  });

  it('cannot reach into another organisation', async () => {
    const res = await adminSend(fx.foreignAdminToken, fx.userId);
    await settlePasswordResets();

    expect(res.status).toBe(404);
    expect(outbox).toEqual([]);
  });

  it('is closed to a recruiter', async () => {
    const res = await adminSend(fx.recruiterToken, fx.userId);
    expect(res.status).toBe(403);
  });

  it('is closed to an admin of another organisation even through the operator route', async () => {
    // Without a configured platform operator, nobody holds that standing.
    const res = await request(app).post(`/api/admin/tenants/${fx.tenantId}/users/${fx.userId}/password-reset`)
      .set('Authorization', `Bearer ${fx.foreignAdminToken}`).send({});
    expect(res.status).toBe(403);
    await settlePasswordResets();
    expect(outbox).toEqual([]);
  });

  it('lets the platform operator reach an organisation whose only admin is locked out', async () => {
    // The one case an in-tenant admin cannot cover: nobody inside holds
    // admin:manage, because the person who did is the one locked out.
    const before = [...config.platformOperatorEmails];
    (config as { platformOperatorEmails: string[] }).platformOperatorEmails = ['asha@reset.local'];
    try {
      const res = await request(app).post(`/api/admin/tenants/${fx.otherTenantId}/users/${fx.foreignUserId}/password-reset`)
        .set('Authorization', `Bearer ${fx.adminToken}`).send({});
      await settlePasswordResets();

      expect(res.status).toBe(202);
      expect(outbox.map((m) => m.to)).toEqual(['fu@other.local']);
      // Recorded in the locked-out organisation's own trail, naming who did it.
      const events = await prisma.auditEvent.findMany({ where: { action: 'password.reset_sent_by_admin' } });
      expect(events).toHaveLength(1);
      expect(events[0].tenantId).toBe(fx.otherTenantId);
      expect(events[0].actorId).toBe(fx.adminId);
      expect(events[0].afterJson).toContain('operator');
    } finally {
      (config as { platformOperatorEmails: string[] }).platformOperatorEmails = before;
    }
  });

  it('still cannot choose the password: the link goes to the mailbox on the account', async () => {
    await adminSend(fx.adminToken, fx.userId);
    await settlePasswordResets();
    expect(outbox.every((m) => m.to === fx.userEmail)).toBe(true);
    // The account itself has not moved until somebody follows the link.
    expect((await login(fx.userEmail, GOOD)).status).toBe(200);
  });
});
