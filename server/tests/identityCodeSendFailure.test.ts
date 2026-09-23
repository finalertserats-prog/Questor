import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { SendTimeoutError } from '../src/providers/email/timing.js';
import { classifyEmailFailure } from '../src/providers/email/failure.js';
import { identityCodeTrouble, IDENTITY_TROUBLE_KIND } from '../src/services/identityCodeTrouble.js';
import { issueIdentityCode, verifyIdentityCode, MAX_ATTEMPTS } from '../src/services/identityCode.js';

/**
 * R6 / S2: a refused identity-code email left nothing for HR, and an SMTP
 * timeout was collapsed into "definitely not sent" — which deleted a challenge
 * whose code may already have been in the candidate's inbox. They then entered
 * a valid code and were told it had expired.
 *
 * Three properties now hold:
 *   - a PERMANENT refusal may undo the issue (nothing was delivered);
 *   - an UNKNOWN outcome must not: the code stays live and still verifies;
 *   - every outcome, including a lockout, leaves an audit row, and a stuck
 *     candidate appears in a feed HR reads.
 */

type Failure = { mode: 'none' | 'refused' | 'deferred' | 'timeout' | 'unreachable' };
const fail = vi.hoisted(() => ({ mode: 'none' } as Failure));
const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string; html: string }>);

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  const { SendTimeoutError: Timeout } = await import('../src/providers/email/timing.js');
  const smtpError = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        switch (fail.mode) {
          case 'refused':
            throw smtpError('550 5.1.1 Recipient address rejected', { responseCode: 550, code: 'EENVELOPE' });
          case 'deferred':
            throw smtpError('451 4.3.0 Temporary failure, please retry', { responseCode: 451, code: 'EENVELOPE' });
          case 'unreachable':
            throw smtpError('connect ECONNREFUSED 127.0.0.1:2525', { code: 'ECONNECTION' });
          case 'timeout':
            // The relay took the message and then stopped answering: the
            // candidate HAS the code, and we will never hear that it went.
            sent.push(msg);
            throw new Timeout(60);
          default:
            sent.push(msg);
            return { status: 'sent', id: `test-${sent.length}` };
        }
      },
    }),
  };
});

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;

beforeEach(async () => {
  await wipe();
  sent.length = 0;
  fail.mode = 'none';
  demo = await createDemoData();
});

const codeIn = (i: number) => /\b(\d{6})\b/.exec(sent[i].text)?.[1] ?? '';
const wrongFor = (code: string) => (code === '000000' ? '111111' : '000000');

const challenges = () => prisma.identityCodeChallenge.count({ where: { sessionId: demo.sessionId } });
const identityAudit = () => prisma.auditEvent.findMany({
  where: { entityId: demo.sessionId, action: { startsWith: 'identity.' } },
  orderBy: { createdAt: 'asc' },
  select: { action: true, afterJson: true },
});

describe('classifying a send failure', () => {
  it('reads an SMTP 5xx as a refusal nothing survived', () => {
    const out = classifyEmailFailure(Object.assign(new Error('550 rejected'), { responseCode: 550 }));
    expect({ certainty: out.certainty, reason: out.reason }).toEqual({ certainty: 'not_delivered', reason: 'refused' });
  });

  it('reads an SMTP 4xx as a deferral nothing survived', () => {
    const out = classifyEmailFailure(Object.assign(new Error('451 try later'), { responseCode: 451 }));
    expect({ certainty: out.certainty, reason: out.reason }).toEqual({ certainty: 'not_delivered', reason: 'deferred' });
  });

  it('reads a connection that never opened as nothing delivered', () => {
    const out = classifyEmailFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' }));
    expect(out.certainty).toBe('not_delivered');
  });

  it('refuses to call a timeout a non-delivery', () => {
    const out = classifyEmailFailure(new SendTimeoutError(60));
    expect({ certainty: out.certainty, reason: out.reason }).toEqual({ certainty: 'unknown', reason: 'timeout' });
  });

  it('treats a socket that died mid-conversation as unknown, not as a non-delivery', () => {
    const out = classifyEmailFailure(Object.assign(new Error('Unexpected socket close'), { code: 'ESOCKET' }));
    expect(out.certainty).toBe('unknown');
  });

  it('treats anything it cannot place as unknown', () => {
    expect(classifyEmailFailure(new Error('smtp down')).certainty).toBe('unknown');
  });

  it('never quotes more than a short detail', () => {
    expect(classifyEmailFailure(new Error('x'.repeat(5000))).detail.length).toBeLessThanOrEqual(200);
  });
});

describe('a permanent refusal', () => {
  beforeEach(() => { fail.mode = 'refused'; });

  it('tells the candidate the address was refused, not "try again"', async () => {
    const out = await issueIdentityCode(demo.sessionId);
    expect(out.kind).toBe('refused');
  });

  it('takes the code back, because nothing was delivered', async () => {
    await issueIdentityCode(demo.sessionId);
    expect(await challenges()).toBe(0);
  });

  it('does not count against the resend cooldown', async () => {
    await issueIdentityCode(demo.sessionId);
    fail.mode = 'none';
    expect((await issueIdentityCode(demo.sessionId)).kind).toBe('sent');
  });

  it('leaves an audit row saying what happened', async () => {
    await issueIdentityCode(demo.sessionId);
    const rows = await identityAudit();
    expect(rows.map((r) => r.action)).toEqual(['identity.code_send_failed']);
    expect(JSON.parse(rows[0].afterJson)).toMatchObject({ certainty: 'not_delivered', reason: 'refused', channel: 'email' });
  });
});

describe('an outcome nobody knows', () => {
  beforeEach(() => { fail.mode = 'timeout'; });

  it('never claims the code was not sent', async () => {
    expect((await issueIdentityCode(demo.sessionId)).kind).toBe('unconfirmed');
  });

  it('keeps the challenge, because the code may be in the inbox', async () => {
    await issueIdentityCode(demo.sessionId);
    expect(await challenges()).toBe(1);
  });

  it('still verifies the code that did arrive', async () => {
    // This is the whole point: the old code deleted this challenge, so the
    // candidate entered a valid code and was told it had expired.
    await issueIdentityCode(demo.sessionId);
    expect((await verifyIdentityCode(demo.sessionId, codeIn(0))).kind).toBe('verified');
  });

  it('leaves an audit row marked unknown', async () => {
    await issueIdentityCode(demo.sessionId);
    const rows = await identityAudit();
    expect(JSON.parse(rows[0].afterJson)).toMatchObject({ certainty: 'unknown', reason: 'timeout' });
  });
});

describe('a deferral', () => {
  it('is honest that it may work in a moment', async () => {
    fail.mode = 'deferred';
    expect((await issueIdentityCode(demo.sessionId)).kind).toBe('deferred');
  });

  it('takes the code back, because a 4xx means the relay did not take it', async () => {
    fail.mode = 'deferred';
    await issueIdentityCode(demo.sessionId);
    expect(await challenges()).toBe(0);
  });
});

describe('a successful send is still audited exactly once', () => {
  it('writes identity.code_sent and nothing else', async () => {
    await issueIdentityCode(demo.sessionId);
    expect((await identityAudit()).map((r) => r.action)).toEqual(['identity.code_sent']);
  });
});

describe('a lockout', () => {
  it('leaves an audit row, not only a log line', async () => {
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    const wrong = wrongFor(codeIn(0));
    for (let i = 0; i < MAX_ATTEMPTS; i++) await verifyIdentityCode(demo.sessionId, wrong, now);
    expect((await identityAudit()).map((r) => r.action)).toContain('identity.code_locked');
  });
});

describe('what HR sees', () => {
  it('lists a candidate whose code could not be sent', async () => {
    fail.mode = 'refused';
    await issueIdentityCode(demo.sessionId);
    const rows = await identityCodeTrouble(demo.tenantId, {}, new Date());
    expect(rows.map((r) => ({ kind: r.kind, sessionId: r.sessionId }))).toEqual([
      { kind: IDENTITY_TROUBLE_KIND, sessionId: demo.sessionId },
    ]);
  });

  it('says which candidate, which role and what went wrong', async () => {
    fail.mode = 'refused';
    await issueIdentityCode(demo.sessionId);
    const [row] = await identityCodeTrouble(demo.tenantId, {}, new Date());
    expect({
      candidate: typeof row.candidate.name === 'string' && row.candidate.name.length > 0,
      role: typeof row.role.title === 'string' && row.role.title.length > 0,
      facts: row.facts,
    }).toEqual({ candidate: true, role: true, facts: { certainty: 'not_delivered', reason: 'refused', channel: 'email' } });
  });

  it('never puts the candidate address in the row', async () => {
    fail.mode = 'refused';
    await issueIdentityCode(demo.sessionId);
    const [row] = await identityCodeTrouble(demo.tenantId, {}, new Date());
    expect(JSON.stringify(row)).not.toContain('@');
  });

  it('stops listing them once the code is confirmed', async () => {
    fail.mode = 'refused';
    await issueIdentityCode(demo.sessionId);
    fail.mode = 'none';
    const now = new Date();
    await issueIdentityCode(demo.sessionId, now);
    await verifyIdentityCode(demo.sessionId, codeIn(0), now);
    expect(await identityCodeTrouble(demo.tenantId, {}, new Date())).toEqual([]);
  });

  it('stops listing them once a later code goes out', async () => {
    fail.mode = 'refused';
    await issueIdentityCode(demo.sessionId);
    fail.mode = 'none';
    await issueIdentityCode(demo.sessionId);
    expect(await identityCodeTrouble(demo.tenantId, {}, new Date())).toEqual([]);
  });
});
