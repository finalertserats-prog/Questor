import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import {
  CODE_TTL_MS, LOCKOUT_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS,
  generateCode, hashCode, identityCodePepper, identityCodeStatus, issueIdentityCode, verifyIdentityCode,
} from '../src/services/identityCode.js';

/**
 * L1 of identity assurance: a six-digit code emailed to the applicant just
 * before the interview. Short-lived, stored only as a keyed hash, limited in
 * attempts and in how often it can be resent, and good for one use.
 *
 * Codes are read back out of the captured mail and compared inside expect();
 * nothing here prints one.
 */

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string; html: string }>);
const failNextSend = vi.hoisted(() => ({ on: false }));
vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        if (failNextSend.on) {
          failNextSend.on = false;
          // A classified refusal (SMTP 550), not a bare Error: only a
          // CERTAIN non-delivery may take the code back. An unclassifiable
          // failure is treated as "may have arrived" and keeps the code —
          // see tests/identityCodeSendFailure.test.ts.
          throw Object.assign(new Error('550 5.1.1 Recipient address rejected'), { responseCode: 550, code: 'EENVELOPE' });
        }
        sent.push(msg);
        return { status: 'sent', id: `test-${sent.length}` };
      },
    }),
  };
});

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;

beforeEach(async () => {
  await wipe();
  sent.length = 0;
  failNextSend.on = false;
  demo = await createDemoData();
});

const codeIn = (i: number) => /\b(\d{6})\b/.exec(sent[i].text)?.[1] ?? '';
const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');
const later = (ms: number, from = new Date()) => new Date(from.getTime() + ms);

describe('the code itself', () => {
  it('is six digits', () => {
    expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it('is stored only as a keyed hash', async () => {
    await issueIdentityCode(demo.sessionId);
    const row = await prisma.identityCodeChallenge.findFirstOrThrow({ where: { sessionId: demo.sessionId } });
    expect([row.codeHash.includes(codeIn(0)), row.codeHash]).toEqual([false, hashCode(demo.sessionId, codeIn(0))]);
  });

  it('hashes the same code differently for a different interview', () => {
    expect(hashCode('session-a', '123456')).not.toBe(hashCode('session-b', '123456'));
  });

  it('expires after ten minutes', () => {
    expect(CODE_TTL_MS).toBe(10 * 60_000);
  });
});

describe('the pepper', () => {
  it('refuses to hash in production without one', () => {
    expect(() => identityCodePepper({ nodeEnv: 'production', pepper: '' })).toThrow(/IDENTITY_CODE_PEPPER/);
  });

  it('uses the configured pepper when there is one', () => {
    expect(identityCodePepper({ nodeEnv: 'production', pepper: 'p'.repeat(40) })).toBe('p'.repeat(40));
  });

  it('falls back to a development pepper outside production', () => {
    expect(identityCodePepper({ nodeEnv: 'test', pepper: '' }).length).toBeGreaterThan(0);
  });
});

describe('sending a code', () => {
  it('emails the applicant at the address on the application', async () => {
    await issueIdentityCode(demo.sessionId);
    expect(sent.map((m) => m.to)).toEqual(['priya.sharma@example.com']);
  });

  it('tells the applicant why the code is asked for and how long it lasts', async () => {
    await issueIdentityCode(demo.sessionId);
    expect([/confirm it.s you/i.test(sent[0].text), /10 minutes/.test(sent[0].text)]).toEqual([true, true]);
  });

  it('keeps the portal link out of the mail', async () => {
    await issueIdentityCode(demo.sessionId);
    expect(/\/(portal|room)\//.test(sent[0].text + sent[0].html) || sent[0].text.includes(demo.token)).toBe(false);
  });

  it('answers with a masked address, never the code', async () => {
    const out = await issueIdentityCode(demo.sessionId);
    expect([out.kind, JSON.stringify(out).includes(codeIn(0)), out.kind === 'sent' && out.destination]).toEqual(['sent', false, 'p••••@example.com']);
  });

  it('waits a minute before sending another', async () => {
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    const again = await issueIdentityCode(demo.sessionId, later(10_000, now));
    expect([again.kind, again.kind === 'wait' && again.retryAfterSeconds, sent.length]).toEqual(['wait', 50, 1]);
  });

  it('sends a new code once the minute has passed', async () => {
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    const again = await issueIdentityCode(demo.sessionId, later(RESEND_COOLDOWN_MS, now));
    expect([again.kind, sent.length]).toEqual(['sent', 2]);
  });

  it('retires the earlier code when a new one is sent', async () => {
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    await issueIdentityCode(demo.sessionId, later(RESEND_COOLDOWN_MS, now));
    const out = await verifyIdentityCode(demo.sessionId, codeIn(0), later(RESEND_COOLDOWN_MS + 1000, now));
    // The old code may happen to equal the new one; only a different one is a real test.
    expect(out.kind).toBe(codeIn(0) === codeIn(1) ? 'verified' : 'wrong');
  });

  it('does not count a refused send against the cooldown', async () => {
    failNextSend.on = true;
    const first = await issueIdentityCode(demo.sessionId);
    const second = await issueIdentityCode(demo.sessionId);
    expect([first.kind, second.kind]).toEqual(['refused', 'sent']);
  });

  it('sends nothing once the applicant is confirmed', async () => {
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    await verifyIdentityCode(demo.sessionId, codeIn(0), now);
    const again = await issueIdentityCode(demo.sessionId, later(RESEND_COOLDOWN_MS, now));
    expect([again.kind, sent.length]).toEqual(['already_verified', 1]);
  });
});

describe('entering the code', () => {
  it('confirms the applicant with the right code', async () => {
    await issueIdentityCode(demo.sessionId);
    expect((await verifyIdentityCode(demo.sessionId, codeIn(0))).kind).toBe('verified');
  });

  it('refuses a wrong code and says how many tries are left', async () => {
    await issueIdentityCode(demo.sessionId);
    const out = await verifyIdentityCode(demo.sessionId, wrongFor(codeIn(0)));
    expect(out).toEqual({ kind: 'wrong', attemptsLeft: MAX_ATTEMPTS - 1 });
  });

  it('refuses the right code after it has expired', async () => {
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    expect((await verifyIdentityCode(demo.sessionId, codeIn(0), later(CODE_TTL_MS + 1, now))).kind).toBe('expired');
  });

  it('is good for one use: a second entry does not confirm again', async () => {
    await issueIdentityCode(demo.sessionId);
    await verifyIdentityCode(demo.sessionId, codeIn(0));
    await verifyIdentityCode(demo.sessionId, codeIn(0));
    const rows = await prisma.identityCodeChallenge.findMany({ where: { sessionId: demo.sessionId, consumedAt: { not: null } } });
    expect(rows.map((r) => r.attempts)).toEqual([1]);
  });

  it('confirms once when the right code is entered twice at the same moment', async () => {
    await issueIdentityCode(demo.sessionId);
    const outs = await Promise.all([verifyIdentityCode(demo.sessionId, codeIn(0)), verifyIdentityCode(demo.sessionId, codeIn(0))]);
    const consumed = await prisma.identityCodeChallenge.count({ where: { sessionId: demo.sessionId, consumedAt: { not: null } } });
    expect([outs.every((o) => o.kind === 'verified'), consumed]).toEqual([true, 1]);
  });

  it('kills the code after five wrong entries', async () => {
    await issueIdentityCode(demo.sessionId);
    const wrong = wrongFor(codeIn(0));
    for (let i = 0; i < MAX_ATTEMPTS; i++) await verifyIdentityCode(demo.sessionId, wrong);
    expect((await verifyIdentityCode(demo.sessionId, codeIn(0))).kind).toBe('locked');
  });

  it('makes the applicant wait fifteen minutes for a new code after five wrong entries', async () => {
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    for (let i = 0; i < MAX_ATTEMPTS; i++) await verifyIdentityCode(demo.sessionId, wrongFor(codeIn(0)), now);
    const soon = await issueIdentityCode(demo.sessionId, later(RESEND_COOLDOWN_MS, now));
    const after = await issueIdentityCode(demo.sessionId, later(LOCKOUT_MS, now));
    expect([soon.kind, after.kind]).toEqual(['wait', 'sent']);
  });

  it('with no code sent, says there is no live code', async () => {
    expect((await verifyIdentityCode(demo.sessionId, '123456')).kind).toBe('expired');
  });
});

describe('the record kept', () => {
  it('keeps when the code was confirmed and how many entries it took', async () => {
    await issueIdentityCode(demo.sessionId);
    await verifyIdentityCode(demo.sessionId, wrongFor(codeIn(0)));
    await verifyIdentityCode(demo.sessionId, codeIn(0));
    const status = await identityCodeStatus(demo.sessionId);
    expect([status.verifiedAt instanceof Date, status.attempts, status.wrongAttempts, status.codesSent, status.channel])
      .toEqual([true, 2, 1, 1, 'email']);
  });
});
