import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { authorizeSession } from '../src/realtime/socket.js';

/**
 * The socket is the transport the interview actually runs over, and it used to
 * authorise a staff JWT by tenant alone: any user of the tenant, any role,
 * could join any session's room (the live transcript), start it, or force it
 * to be assessed. The HTTP routes had object scope, capability checks and the
 * observer-consent gate; the socket had none of them. These tests pin the
 * socket to the same rules.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let otherTenantId = '';
let recruiterAToken = '';
let recruiterBToken = '';
let auditorToken = '';
let outsiderToken = '';
let quietSessionId = '';
let liveSessionId = '';

async function makeUser(tenant: string, email: string, role: string): Promise<string> {
  const user = await prisma.user.create({ data: { tenantId: tenant, email, name: email, passwordHash: 'x', role } });
  return signToken({ userId: user.id, tenantId: tenant, role, email });
}

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();

  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@socket.local', password: 'fixture-admin-passphrase', name: 'Socket Admin', tenantName: 'Socket Org',
  });
  tenantId = reg.body.user.tenantId;
  const other = await prisma.tenant.create({ data: { name: 'Elsewhere Ltd' } });
  otherTenantId = other.id;

  recruiterAToken = await makeUser(tenantId, 'a@socket.local', 'recruiter');
  recruiterBToken = await makeUser(tenantId, 'b@socket.local', 'recruiter');
  auditorToken = await makeUser(tenantId, 'auditor@socket.local', 'auditor');
  outsiderToken = await makeUser(otherTenantId, 'out@elsewhere.local', 'admin');

  // Recruiter A owns the requisition and the candidate; B is a colleague with
  // no assignment to either.
  const roleRes = await request(app).post('/api/roles').set(auth(recruiterAToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  const roleId: string = roleRes.body.role.id;
  const scorecardId: string = roleRes.body.scorecard.id;
  const candRes = await request(app).post('/api/candidates').set(auth(recruiterAToken))
    .send({ fullName: 'Priya Sharma', email: 'priya@example.com', roleId });
  const candidateId: string = candRes.body.candidate.id;

  const quiet = await prisma.interviewSession.create({
    data: { tenantId, candidateId, roleId, scorecardId, state: 'INVITED' },
  });
  quietSessionId = quiet.id;
  // Live, and the candidate was never told anyone might be watching.
  const live = await prisma.interviewSession.create({
    data: { tenantId, candidateId, roleId, scorecardId, state: 'ASSESSING', consentJson: JSON.stringify({}) },
  });
  liveSessionId = live.id;
});

const staff = (token: string) => ({ kind: 'user' as const, tenantId, token });

describe('a staff socket joining a session', () => {
  it('lets the recruiter assigned to the candidate join a session that is not live', async () => {
    const session = await authorizeSession(staff(recruiterAToken), quietSessionId, 'observe');

    expect(session?.id).toBe(quietSessionId);
  });

  it('refuses a colleague in the same tenant who is not assigned to the candidate', async () => {
    const session = await authorizeSession(staff(recruiterBToken), quietSessionId, 'observe');

    expect(session).toBeNull();
  });

  it('refuses a user from another tenant', async () => {
    const session = await authorizeSession({ kind: 'user', tenantId: otherTenantId, token: outsiderToken }, quietSessionId, 'observe');

    expect(session).toBeNull();
  });

  it('refuses an auditor, who may not read candidate detail', async () => {
    const session = await authorizeSession(staff(auditorToken), quietSessionId, 'observe');

    expect(session).toBeNull();
  });

  it('refuses to let even the assigned recruiter watch a live session the candidate was not told about', async () => {
    const session = await authorizeSession(staff(recruiterAToken), liveSessionId, 'observe');

    expect(session).toBeNull();
  });
});

describe('a staff socket driving a session', () => {
  it('lets the assigned recruiter start or finalise', async () => {
    const session = await authorizeSession(staff(recruiterAToken), quietSessionId, 'drive');

    expect(session?.id).toBe(quietSessionId);
  });

  it('refuses an unassigned colleague', async () => {
    const session = await authorizeSession(staff(recruiterBToken), quietSessionId, 'drive');

    expect(session).toBeNull();
  });

  it('refuses a role without interview:drive even when assigned', async () => {
    const reviewerToken = await makeUser(tenantId, 'reviewer@socket.local', 'reviewer');
    const reviewer = await prisma.user.findUniqueOrThrow({ where: { email: 'reviewer@socket.local' } });
    const candidate = await prisma.interviewSession.findUniqueOrThrow({ where: { id: quietSessionId }, select: { candidateId: true } });
    await prisma.candidateAssignment.create({ data: { candidateId: candidate.candidateId, userId: reviewer.id, relation: 'reviewer' } });

    const session = await authorizeSession(staff(reviewerToken), quietSessionId, 'drive');

    expect(session).toBeNull();
  });

  it('refuses a token that does not verify', async () => {
    const session = await authorizeSession({ kind: 'user', tenantId, token: 'not-a-jwt' }, quietSessionId, 'drive');

    expect(session).toBeNull();
  });
});

// The HTTP middleware reads the user again on every request so that removing
// or demoting someone takes effect at once. The socket trusted the role in the
// token, so the same person kept observing and driving until it expired.
describe('a staff socket whose account changed after sign-in', () => {
  it('refuses an admin who has since been demoted', async () => {
    const token = await makeUser(tenantId, 'demoted@socket.local', 'admin');
    await prisma.user.update({ where: { email: 'demoted@socket.local' }, data: { role: 'auditor' } });

    const session = await authorizeSession(staff(token), quietSessionId, 'observe');

    expect(session).toBeNull();
  });

  it('refuses a user who has since been removed', async () => {
    const token = await makeUser(tenantId, 'removed@socket.local', 'admin');
    await prisma.user.delete({ where: { email: 'removed@socket.local' } });

    const session = await authorizeSession(staff(token), quietSessionId, 'drive');

    expect(session).toBeNull();
  });

  it('uses the role the account holds now, not the one in the token', async () => {
    const token = await makeUser(tenantId, 'promoted@socket.local', 'auditor');
    await prisma.user.update({ where: { email: 'promoted@socket.local' }, data: { role: 'admin' } });

    const session = await authorizeSession(staff(token), quietSessionId, 'drive');

    expect(session?.id).toBe(quietSessionId);
  });
});
