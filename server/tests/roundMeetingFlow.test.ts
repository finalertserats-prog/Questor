import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { retentionDays, runRetentionSweep } from '../src/services/dataRights.js';
import { clearTokenCache } from '../src/providers/meeting/tokenCache.js';

/**
 * Human interview rounds get a real meeting when an organisation has chosen a
 * provider — and keep their booking whatever the provider does. Every vendor
 * call is a mocked fetch; supertest talks to the app over node:http, so the
 * stub never intercepts the test's own requests.
 */

const app = createApp();
const ZOOM_SECRET = 'zoom-secret-MARKER-do-not-echo';
const ZOOM_TOKEN = 'zoom-token-MARKER';
const JOIN_URL = 'https://zoom.us/j/987654321';
const DAY_MS = 24 * 60 * 60 * 1000;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
const empty = (status: number) => new Response(null, { status });

/** Answers by route, so each test states only what the vendor does differently. */
function zoomVendor(overrides: { create?: () => Response; patch?: () => Response; remove?: () => Response } = {}) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('https://zoom.us/oauth/token')) return json(200, { access_token: ZOOM_TOKEN, expires_in: 3600 });
    if (method === 'POST' && url.endsWith('/meetings')) return overrides.create?.() ?? json(201, { id: 987654321, join_url: JOIN_URL });
    if (method === 'PATCH') return overrides.patch?.() ?? empty(204);
    if (method === 'DELETE') return overrides.remove?.() ?? empty(204);
    return json(500, {});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const callsTo = (fn: ReturnType<typeof zoomVendor>, method: string) =>
  fn.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method).map(([url, init]) => ({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null }));

function configureZoom() {
  vi.stubEnv('ZOOM_ACCOUNT_ID', 'acct-1');
  vi.stubEnv('ZOOM_CLIENT_ID', 'zoom-client');
  vi.stubEnv('ZOOM_CLIENT_SECRET', ZOOM_SECRET);
  vi.stubEnv('ZOOM_HOST_USER_ID', 'host@example.com');
}

interface Fixture {
  auth: string;
  pipelineId: string;
  candidateId: string;
  tenantId: string;
}

async function atGoldStage(): Promise<Fixture> {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  const auth = `Bearer ${login.body.token as string}`;
  const pipelineId = (await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
  for (const key of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', auth).send({ toStageKey: key });
  }
  return { auth, pipelineId, candidateId: ids.candidateId, tenantId: ids.tenantId };
}

async function useProvider(f: Fixture, provider: string) {
  const res = await request(app).put('/api/admin/policy').set('Authorization', f.auth).send({ policy: { roundMeetingProvider: provider } });
  expect(res.status).toBe(200);
}

const schedule = (f: Fixture, extra: Record<string, unknown> = {}) =>
  request(app).post(`/api/pipelines/${f.pipelineId}/rounds`).set('Authorization', f.auth)
    .send({ stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewers: ['Hiring manager'], ...extra });

const roundPath = (f: Fixture, roundId: string, action: string) => `/api/pipelines/${f.pipelineId}/rounds/${roundId}/${action}`;
const storedRound = (id: string) => prisma.interviewRound.findUniqueOrThrow({ where: { id } });

async function zoomRound(f: Fixture) {
  configureZoom();
  await useProvider(f, 'zoom');
  zoomVendor();
  const res = await schedule(f);
  vi.unstubAllGlobals();
  return res.body.round.id as string;
}

beforeEach(() => {
  clearTokenCache();
  for (const name of ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID', 'ROUND_MEETING_PROVIDER']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('scheduling a human round with the manual provider (default)', () => {
  it('saves the round and asks for a link', async () => {
    const f = await atGoldStage();
    const res = await schedule(f);
    expect({ status: res.status, meeting: res.body.meeting.status, round: res.body.round.meeting.status })
      .toEqual({ status: 201, meeting: 'NEEDS_LINK', round: 'NEEDS_LINK' });
  });

  it('stores a link given when scheduling', async () => {
    const f = await atGoldStage();
    const res = await schedule(f, { meetingUrl: 'https://meet.example.com/abc' });
    expect(res.body.round.meeting).toMatchObject({ provider: 'manual', status: 'MANUAL', url: 'https://meet.example.com/abc' });
  });

  it('refuses a link that is not https', async () => {
    const f = await atGoldStage();
    const res = await schedule(f, { meetingUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });

  it('refuses a meeting link on the AI interview round', async () => {
    await wipe();
    const ids = await createDemoData();
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
    const auth = `Bearer ${login.body.token as string}`;
    const id = (await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
    for (const key of ['bronze', 'silver']) await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey: key });
    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', auth)
      .send({ stageKey: 'silver', scheduledAt: '2026-10-01T09:00:00.000Z', meetingUrl: 'https://meet.example.com/abc' });
    expect(res.status).toBe(400);
  });

  it('uses ROUND_MEETING_PROVIDER when the organisation has not chosen', async () => {
    const f = await atGoldStage();
    configureZoom();
    vi.stubEnv('ROUND_MEETING_PROVIDER', 'zoom');
    zoomVendor();
    const res = await schedule(f);
    expect(res.body.meeting).toMatchObject({ provider: 'zoom', status: 'LINKED' });
  });
});

describe('scheduling with Zoom selected', () => {
  it('creates the meeting and returns its join link', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    zoomVendor();
    const res = await schedule(f, { durationMinutes: 45 });
    expect(res.body.round.meeting).toEqual({ provider: 'zoom', status: 'LINKED', url: JOIN_URL, error: null, stuck: false });
  });

  it('books the meeting at the round time and length', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    const fetchMock = zoomVendor();
    await schedule(f, { durationMinutes: 45 });
    expect(callsTo(fetchMock, 'POST').find((c) => c.url.endsWith('/meetings'))?.body)
      .toMatchObject({ start_time: '2026-10-08T09:00:00Z', duration: 45 });
  });

  it('keeps the vendor meeting id on the round, out of the response', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    zoomVendor();
    const res = await schedule(f);
    const stored = await storedRound(res.body.round.id);
    expect({ stored: stored.meetingExternalId, leaked: /externalId/i.test(JSON.stringify(res.body)) })
      .toEqual({ stored: '987654321', leaked: false });
  });

  it('never returns the client secret or token', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    zoomVendor();
    const res = await schedule(f);
    expect(JSON.stringify(res.body)).not.toContain('MARKER');
  });

  it('keeps the booking when Zoom fails, and says to add a link', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    zoomVendor({ create: () => json(503, {}) });
    const res = await schedule(f);
    expect({
      status: res.status,
      roundStatus: res.body.round.status,
      meeting: res.body.meeting.status,
      message: res.body.meeting.message,
    }).toEqual({ status: 201, roundStatus: 'SCHEDULED', meeting: 'NEEDS_LINK', message: expect.stringMatching(/add a meeting link manually/) });
  });

  it('shows the failure on the round after a reload', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    zoomVendor({ create: () => json(403, {}) });
    await schedule(f);
    const reloaded = await request(app).get(`/api/pipelines/${f.pipelineId}`).set('Authorization', f.auth);
    expect(reloaded.body.pipeline.rounds[0].meeting.error).toMatch(/Zoom refused permission/);
  });

  it('says the provider is not set up when its variables are missing', async () => {
    const f = await atGoldStage();
    await useProvider(f, 'zoom');
    const fetchMock = zoomVendor();
    const res = await schedule(f);
    expect({ message: res.body.meeting.message, calls: fetchMock.mock.calls.length })
      .toEqual({ message: expect.stringMatching(/not fully set up/), calls: 0 });
  });

  it('creates the meeting on retry after a failure', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    zoomVendor({ create: () => json(503, {}) });
    const roundId = (await schedule(f)).body.round.id as string;
    zoomVendor();
    const res = await request(app).post(roundPath(f, roundId, 'meeting/retry')).set('Authorization', f.auth);
    expect(res.body.round.meeting).toMatchObject({ status: 'LINKED', url: JOIN_URL, error: null });
  });

  it('refuses a retry once the meeting exists, so none is booked twice', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    zoomVendor();
    const res = await request(app).post(roundPath(f, roundId, 'meeting/retry')).set('Authorization', f.auth);
    expect(res.status).toBe(409);
  });
});

describe('rescheduling', () => {
  it('moves the Zoom meeting it created', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    const fetchMock = zoomVendor();
    await request(app).post(roundPath(f, roundId, 'reschedule')).set('Authorization', f.auth)
      .send({ scheduledAt: '2026-10-09T10:30:00.000Z', durationMinutes: 30 });
    expect(callsTo(fetchMock, 'PATCH')).toEqual([{
      url: 'https://api.zoom.us/v2/meetings/987654321',
      body: expect.objectContaining({ start_time: '2026-10-09T10:30:00Z', duration: 30 }),
    }]);
  });

  it('records the new time on the round', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    zoomVendor();
    const res = await request(app).post(roundPath(f, roundId, 'reschedule')).set('Authorization', f.auth)
      .send({ scheduledAt: '2026-10-09T10:30:00.000Z' });
    expect({ at: res.body.round.scheduledAt, meeting: res.body.round.meeting.status })
      .toEqual({ at: '2026-10-09T10:30:00.000Z', meeting: 'LINKED' });
  });

  it('keeps the new time when Zoom cannot be updated, and flags the meeting', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    zoomVendor({ patch: () => json(400, {}) });
    const res = await request(app).post(roundPath(f, roundId, 'reschedule')).set('Authorization', f.auth)
      .send({ scheduledAt: '2026-10-09T10:30:00.000Z' });
    expect({ at: res.body.round.scheduledAt, meeting: res.body.round.meeting.status, message: res.body.meeting.message })
      .toEqual({ at: '2026-10-09T10:30:00.000Z', meeting: 'OUT_OF_SYNC', message: expect.stringMatching(/still has the old time/) });
  });

  it('brings an out-of-date meeting back in line on retry', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    zoomVendor({ patch: () => json(400, {}) });
    await request(app).post(roundPath(f, roundId, 'reschedule')).set('Authorization', f.auth).send({ scheduledAt: '2026-10-09T10:30:00.000Z' });
    zoomVendor();
    const res = await request(app).post(roundPath(f, roundId, 'meeting/retry')).set('Authorization', f.auth);
    expect(res.body.round.meeting.status).toBe('LINKED');
  });

  it('reaches the meeting through the provider that created it, even after the organisation switches', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    await useProvider(f, 'manual');
    const fetchMock = zoomVendor();
    await request(app).post(roundPath(f, roundId, 'reschedule')).set('Authorization', f.auth).send({ scheduledAt: '2026-10-09T10:30:00.000Z' });
    expect(callsTo(fetchMock, 'PATCH')).toHaveLength(1);
  });

  it('reminds the recruiter to move a manually linked meeting themselves', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f, { meetingUrl: 'https://meet.example.com/abc' })).body.round.id as string;
    const res = await request(app).post(roundPath(f, roundId, 'reschedule')).set('Authorization', f.auth).send({ scheduledAt: '2026-10-09T10:30:00.000Z' });
    expect(res.body.meeting.message).toMatch(/Update the time in the meeting tool/);
  });

  it('refuses to move a cancelled round', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    await request(app).post(roundPath(f, roundId, 'cancel')).set('Authorization', f.auth).send({});
    const res = await request(app).post(roundPath(f, roundId, 'reschedule')).set('Authorization', f.auth).send({ scheduledAt: '2026-10-09T10:30:00.000Z' });
    expect(res.status).toBe(409);
  });
});

describe('cancelling', () => {
  it('cancels the round and deletes its Zoom meeting', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    const fetchMock = zoomVendor();
    const res = await request(app).post(roundPath(f, roundId, 'cancel')).set('Authorization', f.auth).send({});
    expect({
      round: res.body.round.status,
      meeting: res.body.round.meeting.status,
      deleted: callsTo(fetchMock, 'DELETE').map((c) => c.url),
    }).toEqual({ round: 'CANCELLED', meeting: 'CANCELLED', deleted: ['https://api.zoom.us/v2/meetings/987654321'] });
  });

  it('still cancels the round when Zoom cannot delete the meeting, and says so', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    zoomVendor({ remove: () => json(403, {}) });
    const res = await request(app).post(roundPath(f, roundId, 'cancel')).set('Authorization', f.auth).send({});
    expect({ round: res.body.round.status, meeting: res.body.round.meeting.status, message: res.body.meeting.message })
      .toEqual({ round: 'CANCELLED', meeting: 'CANCEL_FAILED', message: expect.stringMatching(/could not be removed/) });
  });

  it('removes the leftover meeting on retry', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    zoomVendor({ remove: () => json(403, {}) });
    await request(app).post(roundPath(f, roundId, 'cancel')).set('Authorization', f.auth).send({});
    zoomVendor();
    const res = await request(app).post(roundPath(f, roundId, 'meeting/retry')).set('Authorization', f.auth);
    expect(res.body.round.meeting.status).toBe('CANCELLED');
  });

  it('marks the meeting cancelled for a round that never had one', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    const res = await request(app).post(roundPath(f, roundId, 'cancel')).set('Authorization', f.auth).send({});
    expect({ response: res.body.meeting.status, stored: res.body.round.meeting.status }).toEqual({ response: 'CANCELLED', stored: 'CANCELLED' });
  });

  it('refuses to cancel a completed round', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    await request(app).post(roundPath(f, roundId, 'complete')).set('Authorization', f.auth)
      .send({ notes: 'Clear, specific examples of owning a migration end to end.' });
    const res = await request(app).post(roundPath(f, roundId, 'cancel')).set('Authorization', f.auth).send({});
    expect(res.status).toBe(409);
  });

  it('removes a meeting whose creation finished after the round was cancelled', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    // A creation in flight while the recruiter cancels.
    await prisma.interviewRound.update({ where: { id: roundId }, data: { meetingStatus: 'CREATING', meetingProvider: 'zoom' } });
    await request(app).post(roundPath(f, roundId, 'cancel')).set('Authorization', f.auth).send({});
    configureZoom();
    const fetchMock = zoomVendor();
    const { createMeeting } = await import('../src/services/roundMeeting.js');
    await createMeeting({ ...(await storedRound(roundId)), meetingStatus: 'CREATING' }, { stageLabel: 'Gold', candidateId: f.candidateId });
    expect({ deleted: callsTo(fetchMock, 'DELETE').length, stored: (await storedRound(roundId)).meetingExternalId }).toEqual({ deleted: 1, stored: null });
  });
});

describe('recovering from a creation that never finished', () => {
  async function stuckRound(f: Fixture) {
    const roundId = (await schedule(f)).body.round.id as string;
    await prisma.interviewRound.update({
      where: { id: roundId },
      data: { meetingStatus: 'CREATING', meetingProvider: 'zoom', meetingUpdatedAt: new Date(Date.now() - 60 * 60_000) },
    });
    return roundId;
  }

  it('marks the round as stuck', async () => {
    const f = await atGoldStage();
    await stuckRound(f);
    const reloaded = await request(app).get(`/api/pipelines/${f.pipelineId}`).set('Authorization', f.auth);
    expect(reloaded.body.pipeline.rounds[0].meeting).toMatchObject({ status: 'CREATING', stuck: true });
  });

  it('accepts a manual link', async () => {
    const f = await atGoldStage();
    const roundId = await stuckRound(f);
    const res = await request(app).put(roundPath(f, roundId, 'meeting-link')).set('Authorization', f.auth).send({ url: 'https://teams.example.com/x' });
    expect(res.body.round.meeting.status).toBe('MANUAL');
  });

  it('creates the meeting on retry', async () => {
    const f = await atGoldStage();
    const roundId = await stuckRound(f);
    configureZoom();
    await useProvider(f, 'zoom');
    zoomVendor();
    const res = await request(app).post(roundPath(f, roundId, 'meeting/retry')).set('Authorization', f.auth);
    expect(res.body.round.meeting.status).toBe('LINKED');
  });

  it('refuses a manual link while a creation is still running', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    await prisma.interviewRound.update({ where: { id: roundId }, data: { meetingStatus: 'CREATING', meetingProvider: 'zoom', meetingUpdatedAt: new Date() } });
    const res = await request(app).put(roundPath(f, roundId, 'meeting-link')).set('Authorization', f.auth).send({ url: 'https://teams.example.com/x' });
    expect(res.status).toBe(409);
  });

  it('does not let an older attempt overwrite a newer claim', async () => {
    const f = await atGoldStage();
    const roundId = await stuckRound(f);
    const oldAttempt = await storedRound(roundId);
    // A retry claims the round while the old attempt is still out at the vendor.
    await prisma.interviewRound.update({ where: { id: roundId }, data: { meetingUpdatedAt: new Date() } });
    configureZoom();
    const fetchMock = zoomVendor();
    const { createMeeting } = await import('../src/services/roundMeeting.js');
    await createMeeting(oldAttempt, { stageLabel: 'Gold', candidateId: f.candidateId });
    expect({ removed: callsTo(fetchMock, 'DELETE').length, stored: (await storedRound(roundId)).meetingExternalId }).toEqual({ removed: 1, stored: null });
  });
});

describe('manual link fallback', () => {
  it('saves a link on a round that needs one', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    const res = await request(app).put(roundPath(f, roundId, 'meeting-link')).set('Authorization', f.auth).send({ url: 'https://teams.example.com/x' });
    expect(res.body.round.meeting).toMatchObject({ provider: 'manual', status: 'MANUAL', url: 'https://teams.example.com/x', error: null });
  });

  it('treats a human round from before meetings existed as needing a link', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    await prisma.interviewRound.update({ where: { id: roundId }, data: { meetingStatus: null, meetingProvider: null } });
    const reloaded = await request(app).get(`/api/pipelines/${f.pipelineId}`).set('Authorization', f.auth);
    const saved = await request(app).put(roundPath(f, roundId, 'meeting-link')).set('Authorization', f.auth).send({ url: 'https://teams.example.com/x' });
    expect({ shown: reloaded.body.pipeline.rounds[0].meeting.status, saved: saved.body.round.meeting.status })
      .toEqual({ shown: 'NEEDS_LINK', saved: 'MANUAL' });
  });

  it('shows no meeting for the AI interview round', async () => {
    await wipe();
    const ids = await createDemoData();
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
    const auth = `Bearer ${login.body.token as string}`;
    const id = (await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId: ids.candidateId })).body.pipeline.id as string;
    for (const key of ['bronze', 'silver']) await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey: key });
    const res = await request(app).post(`/api/pipelines/${id}/rounds`).set('Authorization', auth)
      .send({ stageKey: 'silver', scheduledAt: '2026-10-01T09:00:00.000Z', sessionId: ids.sessionId });
    expect({ round: res.body.round.meeting, meeting: res.body.meeting }).toEqual({ round: null, meeting: null });
  });

  it('refuses to replace a meeting the provider created', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    const res = await request(app).put(roundPath(f, roundId, 'meeting-link')).set('Authorization', f.auth).send({ url: 'https://teams.example.com/x' });
    expect(res.status).toBe(409);
  });

  it('refuses an http link', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    const res = await request(app).put(roundPath(f, roundId, 'meeting-link')).set('Authorization', f.auth).send({ url: 'http://meet.example.com/abc' });
    expect(res.status).toBe(400);
  });

  it('is not reachable for another organisation', async () => {
    const f = await atGoldStage();
    const roundId = (await schedule(f)).body.round.id as string;
    const other = await request(app).post('/api/auth/register').send({ email: 'admin@meet-other.local', password: 'other-org-long-pass', name: 'Other', tenantName: 'Other Org' });
    const res = await request(app).put(roundPath(f, roundId, 'meeting-link')).set('Authorization', `Bearer ${other.body.token as string}`).send({ url: 'https://x.example.com/y' });
    expect(res.status).toBe(404);
  });
});

describe('provider status', () => {
  it('tells a scheduler which provider will create links', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    const res = await request(app).get('/api/pipelines/meeting-provider').set('Authorization', f.auth);
    expect(res.body).toEqual({ meetingProvider: { provider: 'zoom', label: 'Zoom', configured: true } });
  });

  it('shows admins the selection and variable names, never values', async () => {
    const f = await atGoldStage();
    configureZoom();
    await useProvider(f, 'zoom');
    const res = await request(app).get('/api/admin/providers').set('Authorization', f.auth);
    const zoom = res.body.roundMeeting.options.find((o: { provider: string }) => o.provider === 'zoom');
    expect({
      provider: res.body.roundMeeting.provider,
      source: res.body.roundMeeting.source,
      env: zoom.env.map((e: { name: string }) => e.name),
      leaked: JSON.stringify(res.body).includes('MARKER'),
    }).toEqual({
      provider: 'zoom',
      source: 'tenant',
      env: ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID'],
      leaked: false,
    });
  });

  it('rejects an unknown provider in the policy', async () => {
    const f = await atGoldStage();
    const res = await request(app).put('/api/admin/policy').set('Authorization', f.auth).send({ policy: { roundMeetingProvider: 'webex' } });
    expect(res.status).toBe(400);
  });
});

describe('erasure and retention', () => {
  it('removes booked vendor meetings when the candidate is erased', async () => {
    const f = await atGoldStage();
    await zoomRound(f);
    const fetchMock = zoomVendor();
    const res = await request(app).delete(`/api/candidates/${f.candidateId}`).set('Authorization', f.auth).send({ reason: 'Candidate asked to be forgotten' });
    expect({ erased: res.body.erased, deleted: callsTo(fetchMock, 'DELETE').length, meetings: res.body.deleted.externalMeetings })
      .toEqual({ erased: true, deleted: 1, meetings: 1 });
  });

  it('completes the erasure even when the vendor is down', async () => {
    const f = await atGoldStage();
    await zoomRound(f);
    zoomVendor({ remove: () => json(503, {}) });
    const res = await request(app).delete(`/api/candidates/${f.candidateId}`).set('Authorization', f.auth).send({ reason: 'Candidate asked to be forgotten' });
    expect({ status: res.status, rounds: await prisma.interviewRound.count({ where: { pipelineId: f.pipelineId } }) })
      .toEqual({ status: 200, rounds: 0 });
  });

  it('clears the meeting link and vendor id of a finished round past the window', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    const longAgo = new Date(Date.now() - (retentionDays() + 1) * DAY_MS);
    await prisma.interviewRound.update({ where: { id: roundId }, data: { status: 'COMPLETED', completedAt: longAgo, scheduledAt: longAgo } });
    await runRetentionSweep(new Date());
    const round = await storedRound(roundId);
    expect({ url: round.meetingUrl, id: round.meetingExternalId }).toEqual({ url: null, id: null });
  });

  it('keeps the vendor id of a meeting a cancellation could not remove', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    const longAgo = new Date(Date.now() - (retentionDays() + 1) * DAY_MS);
    await prisma.interviewRound.update({ where: { id: roundId }, data: { status: 'CANCELLED', meetingStatus: 'CANCEL_FAILED', scheduledAt: longAgo } });
    await runRetentionSweep(new Date());
    expect((await storedRound(roundId)).meetingExternalId).toBe('987654321');
  });

  it('keeps the link of a round still inside the window', async () => {
    const f = await atGoldStage();
    const roundId = await zoomRound(f);
    await prisma.interviewRound.update({ where: { id: roundId }, data: { status: 'COMPLETED', completedAt: new Date() } });
    await runRetentionSweep(new Date());
    expect((await storedRound(roundId)).meetingUrl).toBe(JOIN_URL);
  });
});
