import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, DEMO_JD } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { consume } from '../src/middleware/rateLimit.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';

/**
 * Findings from the Codex auth and integrity audits, pinned.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let adminToken = '';
let demoToken = '';
let demoSessionId = '';
let demoUserToken = '';
let candidateId = '';
let roleId = '';
let scorecardId = '';

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const demo = await createDemoData();
  demoToken = demo.token;
  demoSessionId = demo.sessionId;
  const demoUser = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
  tenantId = demoUser.tenantId;
  demoUserToken = signToken({ userId: demoUser.id, tenantId, role: demoUser.role, email: demoUser.email });
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: demoSessionId } });
  candidateId = session.candidateId;
  roleId = session.roleId;
  scorecardId = session.scorecardId;
  const admin = await prisma.user.create({ data: { tenantId, email: 'admin@codex.local', name: 'Admin', passwordHash: 'x', role: 'admin' } });
  adminToken = signToken({ userId: admin.id, tenantId, role: 'admin', email: admin.email });
});

describe('authority after a role change', () => {
  it('takes a demotion into account on the very next request, not when the token expires', async () => {
    const user = await prisma.user.create({ data: { tenantId, email: 'demoted@codex.local', name: 'Demoted', passwordHash: 'x', role: 'admin' } });
    const oldToken = signToken({ userId: user.id, tenantId, role: 'admin', email: user.email });
    await prisma.user.update({ where: { id: user.id }, data: { role: 'recruiter' } });

    const res = await request(app).get('/api/admin/webhooks').set(auth(oldToken));

    expect(res.status).toBe(403);
  });

  it('refuses a token for a user who no longer exists', async () => {
    const user = await prisma.user.create({ data: { tenantId, email: 'gone@codex.local', name: 'Gone', passwordHash: 'x', role: 'recruiter' } });
    const oldToken = signToken({ userId: user.id, tenantId, role: 'recruiter', email: user.email });
    await prisma.user.delete({ where: { id: user.id } });

    const res = await request(app).get('/api/candidates').set(auth(oldToken));

    expect(res.status).toBe(401);
  });
});

describe('a finished interview is read-only through its link', () => {
  const finished = async () => {
    const session = await prisma.interviewSession.create({ data: { tenantId, candidateId, roleId, scorecardId, state: 'REVIEW_READY' } });
    const token = mintInvitationToken();
    await prisma.invitation.create({ data: { sessionId: session.id, ...invitationSecretColumns(token), status: 'sent' } });
    return { session, token };
  };

  it('refuses a consent post and does not move the session to manual handoff', async () => {
    const { session, token } = await finished();

    const res = await request(app).post(`/api/portal/${token}/consent`).send({ accepted: true, recordingConsent: false, accommodationRequest: 'I need a human interview please' });

    const after = await prisma.interviewSession.findUniqueOrThrow({ where: { id: session.id } });
    expect([res.status, after.state]).toEqual([409, 'REVIEW_READY']);
  });

  it('refuses a tech check', async () => {
    const { token } = await finished();

    const res = await request(app).post(`/api/portal/${token}/techcheck`).send({ mic: true, speaker: true });

    expect(res.status).toBe(409);
  });
});

describe('turn timings a browser reports', () => {
  it('refuses an end before the start', async () => {
    const res = await request(app).post(`/api/portal/${demoToken}/turn`).send({ text: 'ok', startMs: 5000, endMs: 1000 });

    expect(res.status).toBe(400);
  });

  it('refuses a timing that is not a measurement of anything', async () => {
    const res = await request(app).post(`/api/portal/${demoToken}/turn`).send({ text: 'ok', startMs: 0, endMs: 999_999_999_999 });

    expect(res.status).toBe(400);
  });
});

describe('erasing a candidate', () => {
  const newCandidate = async (suffix: string) => {
    const created = await request(app).post('/api/candidates').set(auth(adminToken))
      .send({ fullName: `Erase ${suffix}`, email: `erase-${suffix}@example.com`, roleId });
    const session = await prisma.interviewSession.create({ data: { tenantId, candidateId: created.body.candidate.id, roleId, scorecardId, state: 'REVIEW_READY' } });
    return { candidateId: created.body.candidate.id as string, sessionId: session.id };
  };

  it('succeeds when the session has browser-integrity events', async () => {
    const { candidateId: id, sessionId } = await newCandidate('events');
    await prisma.integrityEvent.create({ data: { sessionId, type: 'TAB_BLUR' } });

    const res = await request(app).delete(`/api/candidates/${id}`).set(auth(adminToken)).send({ reason: 'Requested by the candidate' });

    expect([res.status, await prisma.integrityEvent.count({ where: { sessionId } })]).toEqual([200, 0]);
  });

  it('is refused while a resume artifact is under legal hold', async () => {
    const { candidateId: id } = await newCandidate('hold');
    await prisma.artifact.create({ data: { tenantId, candidateId: id, kind: 'resume', legalHold: true } });

    const res = await request(app).delete(`/api/candidates/${id}`).set(auth(adminToken)).send({ reason: 'Requested by the candidate' });

    expect(res.status).toBe(409);
  });

  it('keeps the free-text reason out of the audit record that survives the erasure', async () => {
    const { candidateId: id } = await newCandidate('reason');

    await request(app).delete(`/api/candidates/${id}`).set(auth(adminToken)).send({ reason: 'Asked after a private health disclosure' });

    const event = await prisma.auditEvent.findFirst({ where: { action: 'candidate.erased', entityId: id } });
    expect(event?.afterJson ?? '').not.toContain('health disclosure');
  });
});

describe('approving a scorecard stored before the edit schema existed', () => {
  it('is refused when its scoring settings would poison the engines', async () => {
    const roleRes = await request(app).post('/api/roles').set(auth(adminToken))
      .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Legacy Role', useLlm: false });
    const version = await prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId: roleRes.body.role.id } });
    const profile = JSON.parse(version.profileJson);
    profile.scoringRules.passThreshold = 6500;
    await prisma.roleScorecardVersion.update({ where: { id: version.id }, data: { profileJson: JSON.stringify(profile) } });

    const res = await request(app).post(`/api/roles/${roleRes.body.role.id}/approve`).set(auth(adminToken));

    expect(res.status).toBe(400);
  });
});

describe('bounds on what an interview setup and a candidate may carry', () => {
  it('refuses an interview persona name longer than a name', async () => {
    const res = await request(app).post('/api/interviews').set(auth(demoUserToken))
      .send({ candidateId, persona: { name: 'x'.repeat(81), tone: 'warm' } });

    expect(res.status).toBe(400);
  });

  it('refuses a candidate name the length of a document', async () => {
    const res = await request(app).post('/api/candidates').set(auth(adminToken))
      .send({ fullName: 'x'.repeat(201), email: 'long@example.com', roleId });

    expect(res.status).toBe(400);
  });
});

describe('the shared rate-limit bucket', () => {
  it('refuses once the window is spent', () => {
    const key = `unit-${Date.now()}`;
    consume('unit', key, 60_000, 2);
    consume('unit', key, 60_000, 2);

    expect(consume('unit', key, 60_000, 2).allowed).toBe(false);
  });
});
