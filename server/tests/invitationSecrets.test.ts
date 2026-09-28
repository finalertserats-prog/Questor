import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import {
  backfillInvitationSecrets,
  hashInvitationToken,
  mintInvitationToken,
  openInvitationToken,
  sealInvitationToken,
} from '../src/services/invitations.js';

/**
 * The invitation link is a bearer credential for a person's interview. It is
 * no longer stored in plaintext: looked up by hash, and kept sealed so the app
 * can still show and resend it.
 */

const app = createApp();
let demoToken = '';
let sessionId = '';
let staffAuth = '';

beforeAll(async () => {
  await wipe();
  const demo = await createDemoData();
  demoToken = demo.token;
  sessionId = demo.sessionId;
  const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  staffAuth = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
});

describe('how a token is stored', () => {
  it('never as plaintext', async () => {
    const row = await prisma.invitation.findUniqueOrThrow({ where: { sessionId } });

    expect(row.token).toBeNull();
  });

  it('as its hash, which is what the link is looked up by', async () => {
    const row = await prisma.invitation.findUniqueOrThrow({ where: { sessionId } });

    expect(row.tokenHash).toBe(hashInvitationToken(demoToken));
  });

  it('sealed, so the application can rebuild the link', async () => {
    const row = await prisma.invitation.findUniqueOrThrow({ where: { sessionId } });

    expect(openInvitationToken(row.tokenSealed)).toBe(demoToken);
  });

  it('with a seal that cannot be opened after tampering', () => {
    const sealed = sealInvitationToken(mintInvitationToken());
    const parts = sealed.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');

    expect(openInvitationToken(parts.join('.'))).toBeNull();
  });
});

describe('the candidate portal', () => {
  it('still opens from the link', async () => {
    const res = await request(app).get(`/api/portal/${demoToken}`);

    expect(res.status).toBe(200);
  });

  it('refuses a token of the wrong shape before touching the database', async () => {
    const res = await request(app).get('/api/portal/not%20a%20token');

    expect(res.status).toBe(404);
  });

  it('refuses a well-formed token that was never issued', async () => {
    const res = await request(app).get(`/api/portal/${mintInvitationToken()}`);

    expect(res.status).toBe(404);
  });
});

describe('the staff view of the invitation', () => {
  it('shows the link rebuilt from the sealed copy, never from a plaintext column', async () => {
    const res = await request(app).get(`/api/interviews/${sessionId}`).set('Authorization', staffAuth);

    expect(res.body.invitation.portalUrl).toContain(`/portal/${demoToken}`);
  });

  it('does not expose a raw token field', async () => {
    const res = await request(app).get(`/api/interviews/${sessionId}`).set('Authorization', staffAuth);

    expect(res.body.invitation.token).toBeUndefined();
  });
});

describe('rows written before hashing existed', () => {
  it('are hashed, sealed and cleared by the backfill, and their links keep working', async () => {
    const legacyToken = mintInvitationToken();
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    const other = await prisma.interviewSession.create({
      data: { tenantId: session.tenantId, candidateId: session.candidateId, roleId: session.roleId, scorecardId: session.scorecardId, state: 'INVITED' },
    });
    await prisma.invitation.create({ data: { sessionId: other.id, token: legacyToken, status: 'sent' } });

    const moved = await backfillInvitationSecrets();

    const row = await prisma.invitation.findUniqueOrThrow({ where: { sessionId: other.id } });
    const portal = await request(app).get(`/api/portal/${legacyToken}`);
    expect([moved >= 1, row.token, row.tokenHash === hashInvitationToken(legacyToken), portal.status]).toEqual([true, null, true, 200]);
  });
});
