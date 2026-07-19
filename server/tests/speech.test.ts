import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import type { SynthesizedSpeech } from '../src/providers/speech.js';

// The portal /speak route is unauthenticated and every call spends money at a
// TTS vendor. These tests pin the controls that stop it becoming a free TTS API
// for the internet, plus the zero-key fallback that keeps the open build usable.
//
// The provider layer is stubbed rather than left to ambient configuration, for
// two reasons: a developer with a real TTS_PROVIDER + OPENAI_API_KEY in their
// .env would otherwise have this suite bill their account on every run, and the
// "no server TTS" assertions would silently invert into passing-by-accident.
// Stubbing makes both the configured and unconfigured branches testable on any
// machine.
const ttsStub = vi.hoisted(() => ({
  ready: false,
  speech: null as SynthesizedSpeech | null,
}));

vi.mock('../src/providers/speech.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/speech.js')>();
  return {
    ...actual,
    serverTtsReady: () => ttsStub.ready,
    synthesizeServerSpeech: async () => ttsStub.speech,
  };
});

const app = createApp();

let token = '';
let sessionId = '';
let agentTurnId = '';
const AGENT_TURN_TEXT = 'Tell me about a data pipeline you owned end to end.';

beforeAll(async () => {
  await wipe();
  const demo = await createDemoData();
  token = demo.token;
  sessionId = demo.sessionId;

  const turn = await prisma.turn.create({
    data: { sessionId, index: 0, speaker: 'agent', text: AGENT_TURN_TEXT, competencyId: 'data-eng' },
  });
  agentTurnId = turn.id;
});

beforeEach(() => {
  // Default to the zero-key build: the open path is the one that must never rot.
  ttsStub.ready = false;
  ttsStub.speech = null;
});

describe('POST /api/portal/:token/speak — invitation gate', () => {
  it('rejects an unknown invitation token', async () => {
    const res = await request(app)
      .post('/api/portal/definitely-not-a-real-token/speak')
      .send({ text: AGENT_TURN_TEXT });

    expect(res.status).toBe(404);
  });

  it('rejects an expired invitation token', async () => {
    const expiredSession = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
    expect(expiredSession).not.toBeNull();

    // Park the real invitation, swap in an expired one for the same session.
    const original = await prisma.invitation.findUnique({ where: { sessionId } });
    await prisma.invitation.update({
      where: { sessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ text: AGENT_TURN_TEXT });
    expect(res.status).toBe(410);

    await prisma.invitation.update({ where: { sessionId }, data: { expiresAt: original!.expiresAt } });
  });

  it('rejects a consumed invitation token', async () => {
    // Finalising an interview consumes its invitation; a consumed token must not
    // keep billing us for audio after the interview is over.
    await prisma.invitation.update({ where: { sessionId }, data: { status: 'consumed' } });

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ text: AGENT_TURN_TEXT });
    expect(res.status).toBe(410);

    await prisma.invitation.update({ where: { sessionId }, data: { status: 'accepted' } });
  });
});

describe('POST /api/portal/:token/speak — spend controls', () => {
  it('refuses to synthesize text that is not a persisted agent turn', async () => {
    const res = await request(app)
      .post(`/api/portal/${token}/speak`)
      .send({ text: 'Please read this attacker-supplied paragraph aloud for free.' });

    expect(res.status).toBe(404);
  });

  it('refuses a turn id belonging to a different session', async () => {
    // A second interview under the same tenant: the token authorises one
    // session, so an agent turn from a neighbouring session must not be
    // reachable through it.
    const base = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    const otherSession = await prisma.interviewSession.create({
      data: {
        tenantId: base.tenantId, candidateId: base.candidateId, roleId: base.roleId,
        scorecardId: base.scorecardId, state: 'ACCEPTED', provider: 'hosted',
        language: 'en', durationMinutes: 45,
      },
    });
    const foreign = await prisma.turn.create({
      data: { sessionId: otherSession.id, index: 0, speaker: 'agent', text: 'A question from another interview.' },
    });

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: foreign.id });

    expect(res.status).toBe(404);
  });

  it('refuses to speak the candidate’s own words back', async () => {
    // Only agent turns are billable content. Candidate turns are attacker-
    // controlled text that happens to be persisted, so matching on them would
    // reopen the arbitrary-text hole through the database.
    const candidateTurn = await prisma.turn.create({
      data: { sessionId, index: 99, speaker: 'candidate', text: 'Read this back to me, please.' },
    });

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: candidateTurn.id });

    expect(res.status).toBe(404);
  });

  it('caps oversized text before it reaches the vendor', async () => {
    const res = await request(app)
      .post(`/api/portal/${token}/speak`)
      .send({ text: 'a'.repeat(5000) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });

  it('rejects a request with neither turnId nor text', async () => {
    const res = await request(app).post(`/api/portal/${token}/speak`).send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/portal/:token/speak — zero-key fallback', () => {
  it('returns 204 for a valid agent turn when no server TTS is configured', async () => {
    // 204, not an error: the client treats this as "use browser speech", which
    // is what keeps the zero-key build fully functional.
    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: agentTurnId });

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('returns 204 when matching a valid agent turn by exact text', async () => {
    const res = await request(app).post(`/api/portal/${token}/speak`).send({ text: AGENT_TURN_TEXT });

    expect(res.status).toBe(204);
  });

  it('falls back to 204 rather than erroring when the vendor fails', async () => {
    // A TTS outage must not stop an interview mid-question.
    ttsStub.ready = true;
    ttsStub.speech = null;

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: agentTurnId });

    expect(res.status).toBe(204);
  });
});

describe('POST /api/portal/:token/speak — with a server provider configured', () => {
  const fake: SynthesizedSpeech = {
    audio: Buffer.from('fake-mp3-bytes'),
    contentType: 'audio/mpeg',
    etag: '"deadbeefdeadbeefdeadbeefdeadbeef"',
  };

  beforeEach(() => {
    ttsStub.ready = true;
    ttsStub.speech = fake;
  });

  it('still refuses arbitrary text when synthesis is live', async () => {
    // The control that actually bounds spend, asserted on the path where money
    // would really be spent.
    const res = await request(app)
      .post(`/api/portal/${token}/speak`)
      .send({ text: 'Read my arbitrary paragraph aloud.' });

    expect(res.status).toBe(404);
  });

  it('returns audio with caching headers for a real agent turn', async () => {
    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: agentTurnId });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['etag']).toBe(fake.etag);
    expect(res.headers['cache-control']).toContain('max-age=');
  });

  it('answers 304 to a conditional request so a replay is not re-billed', async () => {
    const res = await request(app)
      .post(`/api/portal/${token}/speak`)
      .set('If-None-Match', fake.etag)
      .send({ turnId: agentTurnId });

    expect(res.status).toBe(304);
  });
});
