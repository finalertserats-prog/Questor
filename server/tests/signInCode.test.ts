import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { hashPassword, signToken, verifyToken } from '../src/services/auth.js';
import { _resetEmail, type EmailMessage } from '../src/providers/email/index.js';
import { MAX_ATTEMPTS, RESEND_COOLDOWN_MS, BYPASS_WINDOW_MS } from '../src/services/signInCode.js';
import { TRUST_COOKIE } from '../src/services/trustedDevice.js';

// The sign-in redesign: organisation, then password, then a six-digit code by
// email, and optionally a device remembered for a week.

const app = createApp();
const PASSWORD = 'a-long-enough-passphrase';

interface Sent { to: string; subject: string; text: string }
let outbox: Sent[] = [];
let sendFailsOnce = false;

const captureProvider = {
  name: 'capture', configured: true, delivers: true,
  send: async (msg: EmailMessage) => {
    if (sendFailsOnce) { sendFailsOnce = false; throw new Error('the mail server is down'); }
    outbox.push({ to: msg.to, subject: msg.subject, text: msg.text });
    return { status: 'sent', id: String(outbox.length) };
  },
};

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return { ...actual, getEmail: () => captureProvider };
});

interface Fx { tenantId: string; adminId: string; adminEmail: string; recruiterId: string; recruiterEmail: string; slug: string }
let fx: Fx;

/** The six digits out of the newest sign-in mail. */
function mailedCode(): string {
  const mail = [...outbox].reverse().find((m) => m.subject.endsWith('is your Questor sign-in code'));
  if (!mail) throw new Error('no sign-in code was emailed');
  const m = /\b(\d{6})\b/.exec(mail.text);
  if (!m) throw new Error('the code email carried no code');
  return m[1];
}

const signIn = (email: string, body: Record<string, unknown> = {}) =>
  request(app).post('/api/auth/login').send({ email, password: PASSWORD, ...body });
const enterCode = (pending: string, code: string) =>
  request(app).post('/api/auth/code').send({ pending, code });

beforeAll(async () => {
  await wipe();
  const tenant = await prisma.tenant.create({ data: { name: 'Code Org', slug: 'code-org' } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, email: 'asha@code.local', name: 'Asha Admin', passwordHash: hashPassword(PASSWORD), role: 'admin' } });
  const recruiter = await prisma.user.create({ data: { tenantId: tenant.id, email: 'rita@code.local', name: 'Rita Recruiter', passwordHash: hashPassword(PASSWORD), role: 'recruiter' } });
  fx = { tenantId: tenant.id, adminId: admin.id, adminEmail: admin.email, recruiterId: recruiter.id, recruiterEmail: recruiter.email, slug: 'code-org' };
});

beforeEach(async () => {
  outbox = [];
  sendFailsOnce = false;
  await prisma.signInChallenge.deleteMany({});
  await prisma.trustedDevice.deleteMany({});
  await prisma.auditEvent.deleteMany({});
  // Back to the default policy ('admins') and a fresh device generation.
  await prisma.tenant.update({ where: { id: fx.tenantId }, data: { policyJson: '{}', mfaEpoch: 0, listed: true } });
  await prisma.user.updateMany({ where: { tenantId: fx.tenantId }, data: { mfaBypassUntil: null } });
  // Roles, passwords and session generations reset too: several tests below
  // move one of them, and a test that fails part-way would otherwise poison
  // every test after it rather than failing alone.
  await prisma.user.update({ where: { id: fx.adminId }, data: { passwordHash: hashPassword(PASSWORD), role: 'admin', sessionsEpoch: 0 } });
  await prisma.user.update({ where: { id: fx.recruiterId }, data: { passwordHash: hashPassword(PASSWORD), role: 'recruiter', sessionsEpoch: 0 } });
});

afterAll(() => { _resetEmail(); });

describe('who is asked for a code', () => {
  it('asks an admin, because the default policy covers admins', async () => {
    const res = await signIn(fx.adminEmail);
    expect(res.status).toBe(200);
    expect(res.body.mfa).toBe('code_sent');
    expect(res.body.token).toBeUndefined();
    expect(outbox.map((m) => m.to)).toEqual([fx.adminEmail]);
  });

  it('does not ask a recruiter under that policy', async () => {
    const res = await signIn(fx.recruiterEmail);
    expect(res.status).toBe(200);
    expect(res.body.mfa).toBeUndefined();
    expect(typeof res.body.token).toBe('string');
    expect(outbox).toEqual([]);
  });

  it('asks everyone when the organisation says so', async () => {
    await prisma.tenant.update({ where: { id: fx.tenantId }, data: { policyJson: JSON.stringify({ mfaPolicy: 'everyone' }) } });
    expect((await signIn(fx.recruiterEmail)).body.mfa).toBe('code_sent');
  });

  it('asks nobody when the organisation switches it off', async () => {
    await prisma.tenant.update({ where: { id: fx.tenantId }, data: { policyJson: JSON.stringify({ mfaPolicy: 'off' }) } });
    expect((await signIn(fx.adminEmail)).body.mfa).toBeUndefined();
  });

  it('asks the platform operator whatever the organisation chose', async () => {
    await prisma.tenant.update({ where: { id: fx.tenantId }, data: { policyJson: JSON.stringify({ mfaPolicy: 'off' }) } });
    const before = [...config.platformOperatorEmails];
    (config as { platformOperatorEmails: string[] }).platformOperatorEmails = [fx.recruiterEmail];
    try {
      // An organisation must not be able to turn the code step off for the
      // owner's account by turning it off for their own.
      expect((await signIn(fx.recruiterEmail)).body.mfa).toBe('code_sent');
    } finally {
      (config as { platformOperatorEmails: string[] }).platformOperatorEmails = before;
    }
  });
});

describe('the code step', () => {
  it('hands back a session for the right code', async () => {
    const started = await signIn(fx.adminEmail);
    const res = await enterCode(started.body.pending, mailedCode());

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user.email).toBe(fx.adminEmail);
  });

  it('accepts a code the way people paste it', async () => {
    const started = await signIn(fx.adminEmail);
    const code = mailedCode();
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect((await enterCode(started.body.pending, spaced)).status).toBe(200);
  });

  it('counts wrong entries and dies after five', async () => {
    const started = await signIn(fx.adminEmail);
    const wrong = mailedCode() === '000000' ? '111111' : '000000';

    const statuses: number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) statuses.push((await enterCode(started.body.pending, wrong)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);

    // And the right code no longer works: the challenge is dead, not merely
    // out of tries for the wrong one.
    expect((await enterCode(started.body.pending, mailedCode())).status).toBe(401);
  });

  it('cannot be used twice', async () => {
    const started = await signIn(fx.adminEmail);
    const code = mailedCode();
    expect((await enterCode(started.body.pending, code)).status).toBe(200);
    expect((await enterCode(started.body.pending, code)).status).toBe(401);
  });

  it('retires an earlier code when a newer one is sent', async () => {
    const first = await signIn(fx.adminEmail);
    const firstCode = mailedCode();
    // Past the cooldown, as a person pressing "send again" a minute later.
    await prisma.signInChallenge.updateMany({ data: { createdAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 1000) } });
    const second = await signIn(fx.adminEmail);
    const secondCode = mailedCode();

    expect((await enterCode(first.body.pending, firstCode)).status).toBe(401);
    expect((await enterCode(second.body.pending, secondCode)).status).toBe(200);
  });

  it('makes a second send wait out a cooldown', async () => {
    expect((await signIn(fx.adminEmail)).body.mfa).toBe('code_sent');
    const again = await signIn(fx.adminEmail);
    expect(again.status).toBe(429);
    expect(again.body.error).toContain('already been sent');
  });

  it('says plainly when the code could not be emailed, rather than pretending', async () => {
    sendFailsOnce = true;
    const res = await signIn(fx.adminEmail);
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('could not email');
    // And the failed send holds nothing against the next try.
    sendFailsOnce = false;
    expect((await signIn(fx.adminEmail)).body.mfa).toBe('code_sent');
  });

  it('never puts the code anywhere but the email', async () => {
    const started = await signIn(fx.adminEmail);
    const code = mailedCode();
    expect(JSON.stringify(started.body)).not.toContain(code);
    const rows = await prisma.signInChallenge.findMany();
    expect(rows[0].codeHash).not.toContain(code);
    expect(rows[0].codeHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the half-signed-in ticket', () => {
  it('is not a session', async () => {
    const started = await signIn(fx.adminEmail);
    // It is signed with the same secret, so the only thing standing between it
    // and the whole app is authenticate() refusing a token with a purpose.
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${started.body.pending}`);
    expect(res.status).toBe(401);
  });

  it('carries no password and no code', async () => {
    const started = await signIn(fx.adminEmail);
    const claims = verifyToken(started.body.pending) as unknown as Record<string, unknown>;
    expect(JSON.stringify(claims)).not.toContain(PASSWORD);
    expect(JSON.stringify(claims)).not.toContain(mailedCode());
    expect(claims.purpose).toBe('signin-code');
  });

  it('does not open an interview socket either', async () => {
    // The socket verifies the same token with the same secret, so it needs the
    // same refusal. Checked at the seam the socket actually uses rather than
    // through a real connection, which needs a running server.
    const started = await signIn(fx.adminEmail);
    const { _currentStaffClaims } = await import('../src/realtime/socket.js');
    expect(await _currentStaffClaims(started.body.pending)).toBeNull();
  });

  it('will not let a real session stand in for it', async () => {
    const session = signToken({ userId: fx.adminId, tenantId: fx.tenantId, role: 'admin', email: fx.adminEmail, pv: 0 });
    const res = await enterCode(session, '123456');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('expired');
  });

  it('cannot be aimed at somebody else\'s challenge', async () => {
    await prisma.tenant.update({ where: { id: fx.tenantId }, data: { policyJson: JSON.stringify({ mfaPolicy: 'everyone' }) } });
    const mine = await signIn(fx.adminEmail);
    await prisma.signInChallenge.updateMany({ data: { createdAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 1000) } });
    const theirs = await signIn(fx.recruiterEmail);
    const theirCode = mailedCode();

    // My ticket names my challenge; their code is not an answer to it.
    expect((await enterCode(mine.body.pending, theirCode)).status).toBe(401);
    expect((await enterCode(theirs.body.pending, theirCode)).status).toBe(200);
  });
});

describe('remembering a device', () => {
  const trustCookie = (res: request.Response): string => {
    const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    return set.find((c) => c.startsWith(`${TRUST_COOKIE}=`))?.split(';')[0] ?? '';
  };

  it('is never assumed', async () => {
    const started = await signIn(fx.adminEmail);
    const done = await enterCode(started.body.pending, mailedCode());
    expect(trustCookie(done)).toBe('');
    expect(await prisma.trustedDevice.count()).toBe(0);
  });

  it('skips the code next time when it was asked for', async () => {
    const started = await signIn(fx.adminEmail, { rememberDevice: true });
    const done = await enterCode(started.body.pending, mailedCode());
    const cookie = trustCookie(done);
    expect(cookie).not.toBe('');

    outbox = [];
    const again = await request(app).post('/api/auth/login').set('Cookie', [cookie]).send({ email: fx.adminEmail, password: PASSWORD });
    expect(again.body.mfa).toBeUndefined();
    expect(typeof again.body.token).toBe('string');
    expect(outbox).toEqual([]);
  });

  it('is granted only by passing a code on the device, never by a sign-in that needed none', async () => {
    const res = await signIn(fx.recruiterEmail, { rememberDevice: true });
    expect(res.status).toBe(200);
    expect(await prisma.trustedDevice.count()).toBe(0);
  });

  it('dies when the password changes', async () => {
    const started = await signIn(fx.adminEmail, { rememberDevice: true });
    const cookie = trustCookie(await enterCode(started.body.pending, mailedCode()));

    const { changeOwnPassword } = await import('../src/services/passwordReset.js');
    expect((await changeOwnPassword(fx.adminId, PASSWORD, 'another-long-enough-phrase', { ip: '1.2.3.4' })).kind).toBe('done');

    outbox = [];
    const again = await request(app).post('/api/auth/login').set('Cookie', [cookie]).send({ email: fx.adminEmail, password: 'another-long-enough-phrase' });
    expect(again.body.mfa).toBe('code_sent');
  });

  it('dies when the role changes', async () => {
    await prisma.tenant.update({ where: { id: fx.tenantId }, data: { policyJson: JSON.stringify({ mfaPolicy: 'everyone' }) } });
    const started = await signIn(fx.recruiterEmail, { rememberDevice: true });
    const cookie = trustCookie(await enterCode(started.body.pending, mailedCode()));

    // A grant a recruiter agreed to does not carry into being an admin.
    await prisma.user.update({ where: { id: fx.recruiterId }, data: { role: 'admin' } });
    const again = await request(app).post('/api/auth/login').set('Cookie', [cookie]).send({ email: fx.recruiterEmail, password: PASSWORD });
    expect(again.body.mfa).toBe('code_sent');
  });

  it('dies when the organisation tightens its policy', async () => {
    const started = await signIn(fx.adminEmail, { rememberDevice: true });
    const cookie = trustCookie(await enterCode(started.body.pending, mailedCode()));

    const token = signToken({ userId: fx.adminId, tenantId: fx.tenantId, role: 'admin', email: fx.adminEmail, pv: 0 });
    const saved = await request(app).put('/api/admin/signin-policy').set('Authorization', `Bearer ${token}`).send({ mfaPolicy: 'everyone' });
    expect(saved.status).toBe(200);
    expect(saved.body.note).toContain('asked for a code again');

    const again = await request(app).post('/api/auth/login').set('Cookie', [cookie]).send({ email: fx.adminEmail, password: PASSWORD });
    expect(again.body.mfa).toBe('code_sent');
  });

  it('is listed and revocable by the person it belongs to', async () => {
    const started = await signIn(fx.adminEmail, { rememberDevice: true });
    const done = await enterCode(started.body.pending, mailedCode());
    const cookie = trustCookie(done);
    const session = `Bearer ${done.body.token}`;

    const listed = await request(app).get('/api/auth/devices').set('Authorization', session).set('Cookie', [cookie]);
    expect(listed.status).toBe(200);
    expect(listed.body.devices).toHaveLength(1);
    expect(listed.body.devices[0].thisDevice).toBe(true);
    // Recognisable, and not a fingerprint.
    expect(typeof listed.body.devices[0].label).toBe('string');

    const gone = await request(app).delete(`/api/auth/devices/${listed.body.devices[0].id}`).set('Authorization', session).set('Cookie', [cookie]);
    expect(gone.status).toBe(200);
    expect(gone.body.devices).toEqual([]);

    const again = await request(app).post('/api/auth/login').set('Cookie', [cookie]).send({ email: fx.adminEmail, password: PASSWORD });
    expect(again.body.mfa).toBe('code_sent');
  });

  it('cannot be reached for somebody else', async () => {
    const started = await signIn(fx.adminEmail, { rememberDevice: true });
    const done = await enterCode(started.body.pending, mailedCode());
    const deviceId = (await prisma.trustedDevice.findFirstOrThrow()).id;

    const recruiterSession = signToken({ userId: fx.recruiterId, tenantId: fx.tenantId, role: 'recruiter', email: fx.recruiterEmail, pv: 0 });
    const res = await request(app).delete(`/api/auth/devices/${deviceId}`).set('Authorization', `Bearer ${recruiterSession}`);
    expect(res.status).toBe(404);
    expect(await prisma.trustedDevice.count({ where: { revokedAt: null } })).toBe(1);
    expect(done.status).toBe(200);
  });

  it('is forgotten for a colleague when an admin says the laptop is gone', async () => {
    const started = await signIn(fx.adminEmail, { rememberDevice: true });
    const cookie = trustCookie(await enterCode(started.body.pending, mailedCode()));

    const token = signToken({ userId: fx.adminId, tenantId: fx.tenantId, role: 'admin', email: fx.adminEmail, pv: 0 });
    const res = await request(app).post(`/api/admin/users/${fx.adminId}/revoke-devices`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(1);

    const again = await request(app).post('/api/auth/login').set('Cookie', [cookie]).send({ email: fx.adminEmail, password: PASSWORD });
    expect(again.body.mfa).toBe('code_sent');
  });
});

describe('break-glass', () => {
  const operatorOn = (email: string) => {
    const before = [...config.platformOperatorEmails];
    (config as { platformOperatorEmails: string[] }).platformOperatorEmails = [email];
    return () => { (config as { platformOperatorEmails: string[] }).platformOperatorEmails = before; };
  };

  it('lets one named person in without a code, once', async () => {
    // Granted by the platform operator, who here is a second account.
    const restore = operatorOn(fx.recruiterEmail);
    try {
      const operator = signToken({ userId: fx.recruiterId, tenantId: fx.tenantId, role: 'recruiter', email: fx.recruiterEmail, pv: 0 });
      const granted = await request(app).post(`/api/admin/tenants/${fx.tenantId}/users/${fx.adminId}/mfa-bypass`)
        .set('Authorization', `Bearer ${operator}`).send({ reason: 'Mail provider outage, ticket OPS-4120, confirmed by phone.' });
      expect(granted.status).toBe(202);
      expect(granted.body.minutes).toBe(BYPASS_WINDOW_MS / 60_000);

      outbox = [];
      const first = await signIn(fx.adminEmail);
      expect(first.body.mfa).toBeUndefined();
      expect(typeof first.body.token).toBe('string');
      expect(outbox).toEqual([]);

      // Once. The second attempt is back to asking for a code.
      const second = await signIn(fx.adminEmail);
      expect(second.body.mfa).toBe('code_sent');
    } finally {
      restore();
    }
  });

  it('still needs the password', async () => {
    const restore = operatorOn(fx.recruiterEmail);
    try {
      const operator = signToken({ userId: fx.recruiterId, tenantId: fx.tenantId, role: 'recruiter', email: fx.recruiterEmail, pv: 0 });
      await request(app).post(`/api/admin/tenants/${fx.tenantId}/users/${fx.adminId}/mfa-bypass`)
        .set('Authorization', `Bearer ${operator}`).send({ reason: 'Mail provider outage, ticket OPS-4120, confirmed by phone.' });

      const res = await request(app).post('/api/auth/login').send({ email: fx.adminEmail, password: 'not-the-password' });
      expect(res.status).toBe(401);
    } finally {
      restore();
    }
  });

  it('insists on a reason worth reading', async () => {
    const restore = operatorOn(fx.recruiterEmail);
    try {
      const operator = signToken({ userId: fx.recruiterId, tenantId: fx.tenantId, role: 'recruiter', email: fx.recruiterEmail, pv: 0 });
      const res = await request(app).post(`/api/admin/tenants/${fx.tenantId}/users/${fx.adminId}/mfa-bypass`)
        .set('Authorization', `Bearer ${operator}`).send({ reason: 'because' });
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it('is closed to an organisation admin', async () => {
    const token = signToken({ userId: fx.adminId, tenantId: fx.tenantId, role: 'admin', email: fx.adminEmail, pv: 0 });
    const res = await request(app).post(`/api/admin/tenants/${fx.tenantId}/users/${fx.recruiterId}/mfa-bypass`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'I would quite like to be able to do this.' });
    expect(res.status).toBe(403);
  });

  it('runs out', async () => {
    await prisma.user.update({ where: { id: fx.adminId }, data: { mfaBypassUntil: new Date(Date.now() - 1000) } });
    expect((await signIn(fx.adminEmail)).body.mfa).toBe('code_sent');
  });
});

describe('a session from before a password change', () => {
  it('cannot drive a live interview either', async () => {
    const stale = signToken({ userId: fx.adminId, tenantId: fx.tenantId, role: 'admin', email: fx.adminEmail, pv: 0 });
    const { _currentStaffClaims } = await import('../src/realtime/socket.js');
    expect(await _currentStaffClaims(stale)).not.toBeNull();

    await prisma.user.update({ where: { id: fx.adminId }, data: { sessionsEpoch: { increment: 1 } } });
    expect(await _currentStaffClaims(stale)).toBeNull();
  });
});

describe('the audit trail', () => {
  const actions = async () => (await prisma.auditEvent.findMany({ orderBy: { createdAt: 'asc' } })).map((e) => e.action);

  it('records the code being sent and confirmed, and the sign-in', async () => {
    const started = await signIn(fx.adminEmail);
    await enterCode(started.body.pending, mailedCode());
    expect(await actions()).toEqual(['auth.code_sent', 'auth.code_confirmed', 'auth.login']);
  });

  it('records a wrong code', async () => {
    const started = await signIn(fx.adminEmail);
    const wrong = mailedCode() === '000000' ? '111111' : '000000';
    await enterCode(started.body.pending, wrong);
    expect(await actions()).toContain('auth.code_failed');
  });

  it('never writes the code down', async () => {
    const started = await signIn(fx.adminEmail);
    const code = mailedCode();
    await enterCode(started.body.pending, code);
    const events = await prisma.auditEvent.findMany();
    expect(events.every((e) => !e.afterJson.includes(code))).toBe(true);
  });

  it('records a device being skipped past rather than letting it look like no policy', async () => {
    const started = await signIn(fx.adminEmail, { rememberDevice: true });
    const done = await enterCode(started.body.pending, mailedCode());
    const set = ([] as string[]).concat(done.headers['set-cookie'] ?? []);
    const cookie = set.find((c) => c.startsWith(`${TRUST_COOKIE}=`))?.split(';')[0] ?? '';

    await prisma.auditEvent.deleteMany({});
    await request(app).post('/api/auth/login').set('Cookie', [cookie]).send({ email: fx.adminEmail, password: PASSWORD });
    expect(await actions()).toEqual(['auth.code_skipped_trusted_device', 'auth.login']);
  });
});

describe('the organisation step', () => {
  it('finds an organisation by the first letters of its name', async () => {
    const res = await request(app).get('/api/orgs?q=cod');
    expect(res.status).toBe(200);
    expect(res.body.orgs.map((o: { slug: string }) => o.slug)).toContain(fx.slug);
  });

  it('answers nothing for a prefix too short to be a real attempt', async () => {
    expect((await request(app).get('/api/orgs?q=co')).body.orgs).toEqual([]);
  });

  it('leaves out an organisation that asked not to be listed', async () => {
    await prisma.tenant.update({ where: { id: fx.tenantId }, data: { listed: false } });
    expect((await request(app).get('/api/orgs?q=cod')).body.orgs).toEqual([]);
    // Their own link still works: the setting hides the name, not the door.
    expect((await request(app).get(`/api/orgs/${fx.slug}`)).status).toBe(200);
  });

  it('holds sign-in to the organisation the person chose', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Elsewhere Ltd', slug: 'elsewhere' } });
    const res = await signIn(fx.recruiterEmail, { orgSlug: 'elsewhere' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    await prisma.tenant.delete({ where: { id: other.id } });
  });
});
