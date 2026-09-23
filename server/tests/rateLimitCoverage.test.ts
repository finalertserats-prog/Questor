import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';
import { _enableRateLimitsInTests, _resetRateLimits } from '../src/middleware/rateLimit.js';

/**
 * §3.3: every rate limiter is disabled under NODE_ENV=test, so NO shipped test
 * covered ANY limit — the defects in them were found by driving a server by
 * hand. This file opts in and covers the ones a candidate or a recruiter can
 * reach: the portal, the identity code and bulk invite. Sign-in has its own
 * file (loginRateLimit.test.ts), because the defect there was the counting.
 *
 * No invitation token is ever printed here: they are bearer credentials for an
 * unauthenticated portal. Assertions are on statuses and counts only.
 */

const app = createApp();

// One office, one address, two candidates: the property that matters for the
// portal is that they do not share a budget.
const OFFICE = '203.0.113.44';

let recruiterToken = '';
let secondUserToken = '';
let tokenA = '';
let tokenB = '';

async function extraInvitation(demo: Awaited<ReturnType<typeof createDemoData>>): Promise<string> {
  const candidate = await prisma.candidate.create({
    data: { tenantId: demo.tenantId, roleId: demo.roleId, fullName: 'Second Candidate', email: 'second@example.com', phone: '' },
  });
  const session = await prisma.interviewSession.create({
    data: {
      tenantId: demo.tenantId, candidateId: candidate.id, roleId: demo.roleId, scorecardId: demo.scorecardId,
      state: 'INVITED', durationMinutes: 45, language: 'en',
    },
  });
  const token = mintInvitationToken();
  await prisma.invitation.create({
    data: {
      sessionId: session.id, ...invitationSecretColumns(token), status: 'sent',
      sentAt: new Date(), expiresAt: new Date(Date.now() + 14 * 864e5),
    },
  });
  return token;
}

beforeAll(async () => {
  await wipe();
  const demo = await createDemoData();
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  recruiterToken = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  const colleague = await prisma.user.create({
    data: { tenantId: demo.tenantId, email: 'colleague@example.com', name: 'Colleague', passwordHash: 'x', role: 'recruiter' },
  });
  secondUserToken = signToken({ userId: colleague.id, tenantId: colleague.tenantId, role: 'recruiter', email: colleague.email });
  tokenA = demo.token;
  tokenB = await extraInvitation(demo);
});

beforeEach(() => {
  _resetRateLimits();
  _enableRateLimitsInTests(true);
});

afterEach(() => {
  _enableRateLimitsInTests(false);
  _resetRateLimits();
});

const bearer = (token: string) => `Bearer ${token}`;

async function repeat(times: number, call: () => Promise<{ status: number }>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) statuses.push((await call()).status);
  return statuses;
}

// ---------------------------------------------------------------------------
// The candidate portal
// ---------------------------------------------------------------------------

describe('the portal limiter', () => {
  const askForCode = (token: string, ip = OFFICE) =>
    request(app).post(`/api/portal/${token}/identity/code`).set('X-Forwarded-For', ip).send({});

  // 30 per 15 minutes per invitation (app.ts, 'portal-identity').
  const IDENTITY_MAX = 30;

  it('bounds how often one invitation can ask for a code', async () => {
    const statuses = await repeat(IDENTITY_MAX + 1, () => askForCode(tokenA));
    expect(statuses.at(-1)).toBe(429);
  });

  it('says how long to wait', async () => {
    await repeat(IDENTITY_MAX, () => askForCode(tokenA));
    const res = await askForCode(tokenA);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('does not answer 429 before the ceiling', async () => {
    const statuses = await repeat(IDENTITY_MAX, () => askForCode(tokenA));
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });

  it('keys on the invitation, not the address: two candidates in one office do not share a budget', async () => {
    await repeat(IDENTITY_MAX + 1, () => askForCode(tokenA, OFFICE));
    expect((await askForCode(tokenB, OFFICE)).status).not.toBe(429);
  });

  it('keys on the invitation, not the address: one token cannot escape by changing address', async () => {
    await repeat(IDENTITY_MAX + 1, () => askForCode(tokenA, OFFICE));
    expect((await askForCode(tokenA, '198.51.100.7')).status).toBe(429);
  });
});

describe('the portal turn limiter', () => {
  // 120 per hour per invitation (app.ts, 'portal-turn'). Every answer costs a
  // paid model call, so this is the cost-amplification path.
  const TURN_MAX = 120;
  const answer = (token: string, ip = OFFICE) =>
    request(app).post(`/api/portal/${token}/turn`).set('X-Forwarded-For', ip).send({ text: 'An answer of a reasonable length.' });

  it('bounds how many turns one invitation can drive', async () => {
    const statuses = await repeat(TURN_MAX + 1, () => answer(tokenA));
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('leaves another candidate behind the same address alone', async () => {
    await repeat(TURN_MAX + 1, () => answer(tokenA, OFFICE));
    expect((await answer(tokenB, OFFICE)).status).not.toBe(429);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Bulk invite
// ---------------------------------------------------------------------------

describe('the bulk-invite limiter', () => {
  // 10 per 15 minutes per USER (app.ts / routes/interviews.ts): every row
  // sends mail, and everyone in an office shares one address.
  const BULK_MAX = 10;
  const invite = (token: string) =>
    request(app).post('/api/interviews/bulk-invite').set('Authorization', bearer(token)).set('X-Forwarded-For', OFFICE).send([]);

  it('bounds how often one person can run it', async () => {
    const statuses = await repeat(BULK_MAX + 1, () => invite(recruiterToken));
    expect(statuses.at(-1)).toBe(429);
  }, 60_000);

  it('does not refuse before the ceiling', async () => {
    const statuses = await repeat(BULK_MAX, () => invite(recruiterToken));
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  }, 60_000);

  it('keys on the person, not the address: a colleague in the same office is unaffected', async () => {
    await repeat(BULK_MAX + 1, () => invite(recruiterToken));
    expect((await invite(secondUserToken)).status).not.toBe(429);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The opt-in itself
// ---------------------------------------------------------------------------

describe('limiters under NODE_ENV=test', () => {
  it('are off unless a test asks for them', async () => {
    _enableRateLimitsInTests(false);
    const statuses = await repeat(35, () => request(app).post(`/api/portal/${tokenA}/identity/code`).send({}));
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  }, 60_000);
});
