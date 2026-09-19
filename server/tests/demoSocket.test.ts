import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { issueSession } from '../src/services/auth.js';
import { provisionDemoTenant } from '../src/services/demoAccess.js';
import { authorizeSession } from '../src/realtime/socket.js';

/**
 * "End demo" and the 45-minute limit stop HTTP requests; the live-interview
 * socket must stop honouring the same session token too.
 */

interface Fixture { token: string; tenantId: string; sessionId: string; grantId: string }

async function demoSession(): Promise<Fixture> {
  await wipe();
  await prisma.demoGrant.deleteMany();
  const p = await provisionDemoTenant({ name: 'Asha', email: 'asha@acme.test', company: 'Acme' });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: p.userId } });
  const grant = await prisma.demoGrant.create({ data: { name: 'Asha', email: 'asha@acme.test', company: 'Acme', status: 'consumed', tenantId: p.tenantId, userId: p.userId, sessionEndsAt: new Date(Date.now() + 30 * 60_000), requestIpHash: '' } });
  const cookies: string[] = [];
  const res = { cookie: (name: string, value: string) => { cookies.push(`${name}=${value}`); } } as unknown as import('express').Response;
  const token = issueSession(res, { userId: user.id, tenantId: p.tenantId, role: user.role, email: user.email, demo: true, demoGrantId: grant.id }, { ttlSeconds: 45 * 60 });
  return { token, tenantId: p.tenantId, sessionId: p.sessionId, grantId: grant.id };
}

let f: Fixture;
beforeEach(async () => { f = await demoSession(); });

describe('demo sockets', () => {
  it('are served while the demo session is live', async () => {
    expect(await authorizeSession({ kind: 'user', tenantId: f.tenantId, token: f.token }, f.sessionId, 'observe')).not.toBeNull();
  });

  it('are refused once the demo session has ended', async () => {
    await prisma.demoGrant.update({ where: { id: f.grantId }, data: { sessionEndsAt: new Date(Date.now() - 1000) } });

    expect(await authorizeSession({ kind: 'user', tenantId: f.tenantId, token: f.token }, f.sessionId, 'observe')).toBeNull();
  });
});
