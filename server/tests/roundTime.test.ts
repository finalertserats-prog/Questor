import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { formatRoundTime } from '../src/services/roundTime.js';

/**
 * The time in a "round scheduled" email is read by a person deciding when to
 * turn up. It used to be toUTCString() — "Thu, 01 Oct 2026 09:00:00 GMT" —
 * which an interviewer in Bengaluru has to convert in their head, and gets
 * wrong by five and a half hours when they forget to.
 */

const sent = vi.hoisted(() => ({ messages: [] as Array<{ to: string; subject: string; text: string; html: string }> }));

vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        sent.messages.push(msg);
        return { status: 'sent', id: `test-${sent.messages.length}` };
      },
    }),
  };
});

const app = createApp();
const AT = new Date('2026-10-01T09:00:00.000Z');

describe('formatting a round time', () => {
  it('uses the tenant time zone when one is set', () => {
    expect(formatRoundTime(AT, 'Asia/Kolkata')).toContain('14:30');
  });

  it('names the offset so the reader knows which clock it is', () => {
    expect(formatRoundTime(AT, 'Asia/Kolkata')).toContain('GMT+5:30');
  });

  it('falls back to an ISO time with an explicit offset when no zone is set', () => {
    expect(formatRoundTime(AT, undefined)).toBe('2026-10-01T09:00:00+00:00 (UTC)');
  });

  it('falls back the same way for a zone the runtime does not know', () => {
    expect(formatRoundTime(AT, 'Mars/Olympus_Mons')).toBe('2026-10-01T09:00:00+00:00 (UTC)');
  });
});

describe('the tenant time zone setting', () => {
  let adminBearer = '';

  beforeEach(async () => {
    await wipe();
    const demo = await createDemoData();
    const admin = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
    adminBearer = `Bearer ${signToken({ userId: admin.id, tenantId: admin.tenantId, role: admin.role, email: admin.email })}`;
  });

  it('accepts an IANA zone', async () => {
    const res = await request(app).put('/api/admin/policy').set('Authorization', adminBearer).send({ policy: { timeZone: 'Asia/Kolkata' } });

    expect(res.status).toBe(200);
  });

  it('refuses a zone that does not exist', async () => {
    const res = await request(app).put('/api/admin/policy').set('Authorization', adminBearer).send({ policy: { timeZone: 'Asia/Nowhere' } });

    expect(res.status).toBe(400);
  });
});

describe('the round scheduled email', () => {
  beforeEach(async () => {
    await wipe();
    sent.messages.length = 0;
  });

  it('states the time in the tenant time zone', async () => {
    const ids = await createDemoData();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ids.tenantId } });
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ ...JSON.parse(tenant.policyJson), timeZone: 'Asia/Kolkata' }) } });
    const user = await prisma.user.findFirstOrThrow({ where: { email: ids.email } });
    const bearer = `Bearer ${signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email })}`;
    const pipelineId = (await request(app).post('/api/pipelines').set('Authorization', bearer).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
    for (const key of ['bronze', 'silver', 'gold']) {
      await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', bearer).send({ toStageKey: key });
    }

    await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', bearer)
      .send({ stageKey: 'gold', scheduledAt: AT.toISOString() });

    expect(sent.messages.at(-1)?.text ?? '').toContain('14:30');
  });
});
