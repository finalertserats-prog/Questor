import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { issueSession, signToken, type AuthClaims } from '../src/services/auth.js';
import { isPlatformOperator, isReservedOperatorEmail } from '../src/middleware/platformOperator.js';
import { bearer, OPERATOR_EMAIL, seedReviewWorld, type ReviewWorld } from './catalogReviewFixtures.js';

/**
 * The platform owner is whoever PLATFORM_OPERATOR_EMAILS names, nobody else:
 * not an organisation admin, not a demo visitor, and nobody at all when the
 * setting is empty.
 */

const app = createApp();
let world: ReviewWorld;

beforeEach(async () => {
  world = await seedReviewWorld();
});

function claims(email: string, extra: Partial<AuthClaims> = {}): AuthClaims {
  return { userId: 'u', tenantId: 't', role: 'admin', email, ...extra };
}

async function demoToken(email: string): Promise<string> {
  const tenant = await prisma.tenant.create({ data: { name: 'Demo org', isDemo: true } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email, name: 'Demo', passwordHash: 'x', role: 'admin' } });
  const grant = await prisma.demoGrant.create({ data: { name: 'Demo', email, company: 'Demo', status: 'consumed', tenantId: tenant.id, userId: user.id, sessionEndsAt: new Date(Date.now() + 30 * 60_000), requestIpHash: '' } });
  const res = { cookie: () => undefined } as unknown as import('express').Response;
  return issueSession(res, { userId: user.id, tenantId: tenant.id, role: 'admin', email, demo: true, demoGrantId: grant.id }, { ttlSeconds: 1800 });
}

describe('who is a platform operator', () => {
  it('is a signed-in user whose email is listed', () => {
    expect(isPlatformOperator(claims(OPERATOR_EMAIL))).toBe(true);
  });

  it('ignores case in the email', () => {
    expect(isPlatformOperator(claims('Owner@Questor.TEST'))).toBe(true);
  });

  it('ignores case in the configured list', () => {
    config.platformOperatorEmails = ['OWNER@questor.test'];
    expect(isPlatformOperator(claims(OPERATOR_EMAIL))).toBe(true);
  });

  it('is nobody when the list is empty', () => {
    config.platformOperatorEmails = [];
    expect(isPlatformOperator(claims(OPERATOR_EMAIL))).toBe(false);
  });

  it('is never a demo session, even with a listed email', () => {
    expect(isPlatformOperator(claims(OPERATOR_EMAIL, { demo: true }))).toBe(false);
  });

  it('is nobody who is not signed in', () => {
    expect(isPlatformOperator(undefined)).toBe(false);
  });
});

describe('the catalog review API', () => {
  it('lets the operator in', async () => {
    const res = await request(app).get('/api/catalog-review/proposals').set('Authorization', bearer(world.operator.token));
    expect(res.status).toBe(200);
  });

  it('refuses an organisation admin who is not an operator', async () => {
    const res = await request(app).get('/api/catalog-review/proposals').set('Authorization', bearer(world.admin.token));
    expect(res.status).toBe(403);
  });

  it('refuses everyone when no operator is configured', async () => {
    config.platformOperatorEmails = [];
    const res = await request(app).get('/api/catalog-review/proposals').set('Authorization', bearer(world.operator.token));
    expect(res.status).toBe(403);
  });

  it('refuses a demo session whose email is listed', async () => {
    const email = `demo-owner-${Date.now()}@questor.test`;
    config.platformOperatorEmails = [email];
    const res = await request(app).get('/api/catalog-review/runs').set('Authorization', bearer(await demoToken(email)));
    expect(res.status).toBe(403);
  });

  it('refuses a request with no session', async () => {
    const res = await request(app).get('/api/catalog-review/proposals');
    expect(res.status).toBe(401);
  });

  it('refuses a write from a non-operator', async () => {
    const res = await request(app).post('/api/catalog-review/runs').set('Authorization', bearer(world.admin.token)).send({});
    expect(res.status).toBe(403);
  });

  it('matches the token email case-insensitively', async () => {
    const token = signToken({ userId: world.operator.id, tenantId: world.operator.tenantId, role: 'admin', email: OPERATOR_EMAIL.toUpperCase() });
    const res = await request(app).get('/api/catalog-review/proposals').set('Authorization', bearer(token));
    expect(res.status).toBe(200);
  });
});

describe('GET /api/auth/me', () => {
  it('tells the web app the operator may review the catalog', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', bearer(world.operator.token));
    expect(res.body.user.platformOperator).toBe(true);
  });

  it('tells the web app an ordinary admin may not', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', bearer(world.admin.token));
    expect(res.body.user.platformOperator).toBe(false);
  });
});

describe('the approver address is reserved too', () => {
  /**
   * Two settings confer deployment-wide standing and only one of them was
   * reserved. `isOperator` (middleware/operator.ts) keys the signup queue —
   * every organisation's applicants — on SIGNUP_APPROVER_EMAIL, while this
   * guard checked PLATFORM_OPERATOR_EMAILS alone. An approver address with no
   * account was therefore claimable: a tenant admin creates it inside their
   * own organisation, signs in, and reads the other organisations' queues.
   *
   * Found unclaimed on the live deployment, where the approver was set and had
   * no User row. Global email uniqueness was the only thing in the way, and
   * that is a race, not a guard.
   */
  const APPROVER = 'ops@questor.invalid';

  it('refuses to let anyone register the approver address', () => {
    const before = config.signupApproverEmail;
    try {
      (config as { signupApproverEmail: string }).signupApproverEmail = APPROVER;
      expect(isReservedOperatorEmail(APPROVER)).toBe(true);
      expect(isReservedOperatorEmail(APPROVER.toUpperCase())).toBe(true);
      expect(isReservedOperatorEmail(` ${APPROVER} `)).toBe(true);
    } finally {
      (config as { signupApproverEmail: string }).signupApproverEmail = before;
    }
  });

  it('still reserves the catalog owner addresses', () => {
    expect(isReservedOperatorEmail(OPERATOR_EMAIL)).toBe(true);
  });

  it('reserves nothing when neither setting names an address', () => {
    const beforeApprover = config.signupApproverEmail;
    const beforeOperators = config.platformOperatorEmails;
    try {
      (config as { signupApproverEmail: string }).signupApproverEmail = '';
      (config as { platformOperatorEmails: string[] }).platformOperatorEmails = [];
      expect(isReservedOperatorEmail(APPROVER)).toBe(false);
      expect(isReservedOperatorEmail(OPERATOR_EMAIL)).toBe(false);
    } finally {
      (config as { signupApproverEmail: string }).signupApproverEmail = beforeApprover;
      (config as { platformOperatorEmails: string[] }).platformOperatorEmails = beforeOperators;
    }
  });

  it('does not make the approver a catalog owner', () => {
    const before = config.signupApproverEmail;
    try {
      (config as { signupApproverEmail: string }).signupApproverEmail = APPROVER;
      // Reserved is not the same as entitled. The approver reads the signup
      // queue; the shared catalog still belongs to PLATFORM_OPERATOR_EMAILS
      // alone, and widening the reservation must not widen that.
      expect(isPlatformOperator(claims(APPROVER))).toBe(false);
    } finally {
      (config as { signupApproverEmail: string }).signupApproverEmail = before;
    }
  });
});
