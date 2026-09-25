import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { clearTokenCache } from '../src/providers/meeting/tokenCache.js';
import { tenantMeetingProvider } from '../src/services/roundMeeting.js';

/**
 * A demo sandbox must never book a real Zoom / Teams / Meet meeting on the
 * deployment's account, whatever provider is configured: anyone can request a
 * demo, and each booking lands in a real calendar.
 */

const app = createApp();

function configureZoom() {
  vi.stubEnv('ZOOM_ACCOUNT_ID', 'acct-1');
  vi.stubEnv('ZOOM_CLIENT_ID', 'zoom-client');
  vi.stubEnv('ZOOM_CLIENT_SECRET', 'zoom-client-value');
  vi.stubEnv('ZOOM_HOST_USER_ID', 'host@example.com');
}

async function zoomOrgAtGoldStage() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  const auth = `Bearer ${login.body.token as string}`;
  configureZoom();
  const policy = await request(app).put('/api/admin/policy').set('Authorization', auth).send({ policy: { roundMeetingProvider: 'zoom' } });
  expect(policy.status).toBe(200);
  const pipelineId = (await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
  for (const key of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', auth).send({ toStageKey: key });
  }
  return { auth, pipelineId, tenantId: ids.tenantId };
}

beforeEach(() => {
  clearTokenCache();
  for (const name of ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID', 'ROUND_MEETING_PROVIDER']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('M8: meetings in a demo sandbox', () => {
  it('resolves a demo tenant to the manual provider even when a vendor is selected', async () => {
    const f = await zoomOrgAtGoldStage();
    await prisma.tenant.update({ where: { id: f.tenantId }, data: { isDemo: true } });

    expect(await tenantMeetingProvider(f.tenantId)).toBe('manual');
  });

  it('schedules a demo round without calling the meeting vendor', async () => {
    const f = await zoomOrgAtGoldStage();
    // The admin screens are closed to a demo, so the sandbox is marked after the policy is set.
    await prisma.tenant.update({ where: { id: f.tenantId }, data: { isDemo: true } });
    const vendor = vi.fn(async () => new Response(JSON.stringify({ id: 1, join_url: 'https://zoom.us/j/1', access_token: 't', expires_in: 3600 }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', vendor);

    const res = await request(app).post(`/api/pipelines/${f.pipelineId}/rounds`).set('Authorization', f.auth)
      .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewers: ['Hiring manager'] });

    expect({ status: res.status, provider: res.body.round?.meeting?.provider, vendorCalls: vendor.mock.calls.length }).toEqual({ status: 201, provider: 'manual', vendorCalls: 0 });
  });

  it('still uses the selected vendor for an ordinary organisation', async () => {
    const f = await zoomOrgAtGoldStage();

    expect(await tenantMeetingProvider(f.tenantId)).toBe('zoom');
  });
});
