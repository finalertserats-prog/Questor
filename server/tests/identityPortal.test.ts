import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * The one-time code in the candidate's journey: asked for after consent and
 * before the room opens, required by the engine on every transport, and never
 * asked again for a candidate coming back to an interview already under way.
 *
 * Tokens and codes are compared inside expect(); nothing here prints one.
 */

const delivery = vi.hoisted(() => ({ delivers: true, sent: [] as Array<{ to: string; text: string; html: string }> }));
vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: delivery.delivers,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        delivery.sent.push(msg);
        return { status: delivery.delivers ? 'sent' : 'logged', id: `test-${delivery.sent.length}` };
      },
    }),
  };
});

const app = createApp();
type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;

beforeEach(async () => {
  await wipe();
  delivery.sent.length = 0;
  delivery.delivers = true;
  demo = await createDemoData();
});

const portal = (path = '') => `/api/portal/${demo.token}${path}`;
const consent = () => request(app).post(portal('/consent')).send({ recordingConsent: true, accepted: true });
const codeMail = () => delivery.sent.find((m) => /\b\d{6}\b/.test(m.text));
const lastCode = () => /\b(\d{6})\b/.exec(codeMail()?.text ?? '')?.[1] ?? '';

async function consentedAndConfirmed() {
  await consent();
  await request(app).post(portal('/identity/code')).send({});
  return request(app).post(portal('/identity/verify')).send({ code: lastCode() });
}

// A session as the recruiter routes create it: the disclosure is drafted, but
// nobody has agreed to it yet. (The seed marks its session as consented.)
async function notYetConsented() {
  const s = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
  const { consentedAt: _dropped, ...drafted } = JSON.parse(s.consentJson);
  await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { consentJson: JSON.stringify(drafted) } });
}

describe('what the portal says before consent', () => {
  beforeEach(notYetConsented);

  it('tells the candidate a code will be emailed', async () => {
    const res = await request(app).get(portal());
    expect([res.body.identity.required, res.body.identity.channel, res.body.identity.verified]).toEqual([true, 'email', false]);
  });

  it('shows where the code goes only as a masked address', async () => {
    const res = await request(app).get(portal());
    expect(res.body.identity.destination).toBe('p••••@example.com');
  });

  it('asks for no code where this deployment cannot deliver email', async () => {
    delivery.delivers = false;
    const res = await request(app).get(portal());
    expect(res.body.identity.required).toBe(false);
  });
});

describe('consent records which identity check applies', () => {
  it('records the email code for a Standard organisation', async () => {
    await consent();
    const s = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(JSON.parse(s.consentJson).identityCheck).toMatchObject({ level: 'standard', method: 'email_code' });
  });

  it('tells the page which check it just recorded', async () => {
    const res = await consent();
    expect([res.body.identity.required, res.body.identity.verified]).toEqual([true, false]);
  });

  it('records that the check could not run when email is not delivered', async () => {
    delivery.delivers = false;
    await consent();
    const s = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(JSON.parse(s.consentJson).identityCheck).toMatchObject({ method: 'none', reason: 'email_not_configured' });
  });
});

describe('in a demo sandbox', () => {
  it('asks no code of a candidate address the demo will not mail', async () => {
    await prisma.tenant.update({ where: { id: demo.tenantId }, data: { isDemo: true } });
    await consent();
    const s = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demo.sessionId } });
    expect(JSON.parse(s.consentJson).identityCheck).toMatchObject({ method: 'none', reason: 'demo_address' });
  });

  it('lets that candidate start without a code', async () => {
    await prisma.tenant.update({ where: { id: demo.tenantId }, data: { isDemo: true } });
    await consent();
    const res = await request(app).post(portal('/start')).send({});
    expect(res.status).toBe(200);
  });
});

describe('sending and entering the code', () => {
  it('sends the code once the candidate has consented', async () => {
    await consent();
    const res = await request(app).post(portal('/identity/code')).send({});
    expect([res.status, res.body.sent, !!codeMail()]).toEqual([200, true, true]);
  });

  it('never puts the code in the response', async () => {
    await consent();
    const res = await request(app).post(portal('/identity/code')).send({});
    expect(JSON.stringify(res.body).includes(lastCode())).toBe(false);
  });

  it('refuses to send a code before consent', async () => {
    await notYetConsented();
    const res = await request(app).post(portal('/identity/code')).send({});
    expect([res.status, res.body.code, delivery.sent.length]).toEqual([409, 'consent_required', 0]);
  });

  it('sends no code for a consent that did not include one', async () => {
    const res = await request(app).post(portal('/identity/code')).send({});
    expect([res.status, res.body.code]).toEqual([409, 'identity_code_not_needed']);
  });

  it('asks the candidate to wait before resending, with the seconds left', async () => {
    await consent();
    await request(app).post(portal('/identity/code')).send({});
    const again = await request(app).post(portal('/identity/code')).send({});
    expect([again.status, again.body.sent, again.body.retryAfterSeconds > 0, delivery.sent.length]).toEqual([200, false, true, 1]);
  });

  it('confirms the candidate with the right code', async () => {
    const res = await consentedAndConfirmed();
    expect([res.status, res.body.verified]).toEqual([200, true]);
  });

  it('refuses a wrong code, saying how many tries are left', async () => {
    await consent();
    await request(app).post(portal('/identity/code')).send({});
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    const res = await request(app).post(portal('/identity/verify')).send({ code: wrong });
    expect([res.status, res.body.attemptsLeft]).toEqual([400, 4]);
  });

  it('rejects something that is not a six-digit code without counting it', async () => {
    await consent();
    await request(app).post(portal('/identity/code')).send({});
    await request(app).post(portal('/identity/verify')).send({ code: 'abc' });
    const row = await prisma.identityCodeChallenge.findFirstOrThrow({ where: { sessionId: demo.sessionId } });
    expect(row.attempts).toBe(0);
  });

  it('accepts the code typed with spaces', async () => {
    await consent();
    await request(app).post(portal('/identity/code')).send({});
    const spaced = `${lastCode().slice(0, 3)} ${lastCode().slice(3)}`;
    const res = await request(app).post(portal('/identity/verify')).send({ code: spaced });
    expect(res.body.verified).toBe(true);
  });

  it('shows the candidate as confirmed afterwards', async () => {
    await consentedAndConfirmed();
    const res = await request(app).get(portal());
    expect(res.body.identity.verified).toBe(true);
  });
});

describe('the room will not open without the code', () => {
  it('refuses to start before the code is entered', async () => {
    await consent();
    const res = await request(app).post(portal('/start')).send({});
    expect([res.status, res.body.code]).toEqual([409, 'identity_code_required']);
  });

  it('starts once the code is entered', async () => {
    await consentedAndConfirmed();
    const res = await request(app).post(portal('/start')).send({});
    expect(res.status).toBe(200);
  });

  it('starts without a code where email cannot be delivered', async () => {
    delivery.delivers = false;
    await consent();
    const res = await request(app).post(portal('/start')).send({});
    expect(res.status).toBe(200);
  });

  it('starts without a code for a consent given before identity checks existed', async () => {
    // The seeded session carries a consent with no identityCheck on it.
    const res = await request(app).post(portal('/start')).send({});
    expect(res.status).toBe(200);
  });
});

describe('rejoining', () => {
  it('asks for no new code when the candidate comes back mid-interview', async () => {
    await consentedAndConfirmed();
    await request(app).post(portal('/start')).send({});
    const rejoin = await request(app).post(portal('/start')).send({});
    expect([rejoin.status, rejoin.body.resumed]).toEqual([200, true]);
  });

  it('asks for no new code when the same interview is reopened before it went live', async () => {
    await consentedAndConfirmed();
    await consent();
    const res = await request(app).post(portal('/start')).send({});
    expect(res.status).toBe(200);
  });

  it('sends no further code once confirmed', async () => {
    await consentedAndConfirmed();
    const res = await request(app).post(portal('/identity/code')).send({});
    expect([res.body.verified, delivery.sent.length]).toEqual([true, 1]);
  });
});
