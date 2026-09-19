import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, type DemoIds } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { seedInterviewers } from '../src/services/interviewers.js';
import type { SynthesizedSpeech, VoiceSelection } from '../src/providers/speech.js';

// Every spoken turn, nudge and preview uses the session's (or the previewed)
// interviewer's voice, and cache keys never let one voice's audio stand in for
// another's. The vendor call is stubbed; speechEtag stays real.

const tts = vi.hoisted(() => ({
  ready: false,
  voices: [] as Array<VoiceSelection | null | undefined>,
  texts: [] as string[],
}));

vi.mock('../src/providers/speech.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/speech.js')>();
  return {
    ...actual,
    serverTtsReady: () => tts.ready,
    synthesizeServerSpeech: async (text: string, voice?: VoiceSelection | null): Promise<SynthesizedSpeech | null> => {
      tts.voices.push(voice);
      tts.texts.push(text);
      return tts.ready ? { audio: Buffer.from('ID3fake-audio'), contentType: 'audio/mpeg', etag: '"x"' } : null;
    },
  };
});

const app = createApp();
let ids: DemoIds;
let bearer = '';
let agentTurnId = '';
const saved = { provider: '', key: '' };

beforeEach(async () => {
  tts.ready = false;
  tts.voices = [];
  tts.texts = [];
  saved.provider = config.tts.provider;
  saved.key = config.llm.openaiKey;
  // A real connector for the ETag computation; synthesis itself is stubbed.
  config.tts.provider = 'openai';
  config.llm.openaiKey = 'test-openai-key-not-real';
  await wipe();
  await prisma.aIInterviewer.deleteMany();
  await prisma.voiceProfile.deleteMany();
  await seedInterviewers('openai');
  ids = await createDemoData();
  bearer = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
  agentTurnId = (await prisma.turn.create({ data: { sessionId: ids.sessionId, index: 0, speaker: 'agent', text: 'Tell me about a pipeline you owned.', competencyId: 'x' } })).id;
});

afterEach(() => {
  config.tts.provider = saved.provider;
  config.llm.openaiKey = saved.key;
});

async function useInterviewer(id: string, name: string): Promise<void> {
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { personaJson: JSON.stringify({ interviewerId: id, name, tone: 'warm' }) } });
}

const speak = () => request(app).post(`/api/portal/${ids.token}/speak`).send({ turnId: agentTurnId });

describe('portal speech uses the session interviewer voice', () => {
  it('speaks a turn with the interviewer voice profile', async () => {
    tts.ready = true;
    await useInterviewer('adrian', 'Adrian');
    await speak();
    expect(tts.voices.at(-1)).toEqual({ provider: 'openai', voiceId: 'cedar' });
  });

  it('speaks a silence nudge with the same voice', async () => {
    tts.ready = true;
    await useInterviewer('elena', 'Elena');
    await request(app).post(`/api/portal/${ids.token}/nudge`).send({ index: 0 });
    expect(tts.voices.at(-1)).toEqual({ provider: 'openai', voiceId: 'coral' });
  });

  it('gives the same turn a different ETag under a different interviewer', async () => {
    tts.ready = true;
    await useInterviewer('maya', 'Maya');
    const first = (await speak()).headers.etag;
    await useInterviewer('theo', 'Theo');
    const second = (await speak()).headers.etag;
    expect(first).not.toBe(second);
  });

  it('keeps demo sandboxes on browser speech', async () => {
    tts.ready = true;
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { isDemo: true } });
    const res = await speak();
    expect(res.status).toBe(204);
  });

  it('tells the room the interviewer name and browser voice hint, never the provider voice', async () => {
    await useInterviewer('maya', 'Maya');
    const res = await request(app).get(`/api/portal/${ids.token}`);
    expect([res.body.persona, JSON.stringify(res.body).includes('marin')]).toEqual([{ name: 'Maya', interviewerId: 'maya', voiceHint: 'female:0' }, false]);
  });
});

describe('GET /api/interviewers/:id/preview', () => {
  const preview = (id: string, auth = bearer) => request(app).get(`/api/interviewers/${id}/preview`).set('Authorization', auth);

  it('requires a signed-in HR user', async () => {
    const res = await request(app).get('/api/interviewers/maya/preview');
    expect(res.status).toBe(401);
  });

  it('refuses a role without interview set-up rights', async () => {
    const user = await prisma.user.create({ data: { tenantId: ids.tenantId, email: 'reviewer@questor.local', name: 'Reviewer', passwordHash: 'x', role: 'reviewer' } });
    const reviewer = `Bearer ${signToken({ userId: user.id, tenantId: ids.tenantId, role: 'reviewer', email: user.email })}`;
    const res = await preview('maya', reviewer);
    expect(res.status).toBe(403);
  });

  it('returns audio synthesised with that interviewer voice', async () => {
    tts.ready = true;
    const res = await preview('adrian');
    expect([res.status, res.headers['content-type'], tts.voices.at(-1)]).toEqual([200, 'audio/mpeg', { provider: 'openai', voiceId: 'cedar' }]);
  });

  it('says the sample line in the interviewer name', async () => {
    tts.ready = true;
    await preview('elena');
    expect(tts.texts.at(-1)).toBe("Hi, I'm Elena, an AI interviewer from Questor.");
  });

  it('answers 204 with a browser voice hint when there is no server voice', async () => {
    const res = await preview('theo');
    expect([res.status, res.headers['x-voice-hint']]).toEqual([204, 'male:1']);
  });

  it('answers 204 for a demo sandbox', async () => {
    tts.ready = true;
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { isDemo: true } });
    const res = await preview('maya');
    expect(res.status).toBe(204);
  });

  it('refuses an unknown interviewer', async () => {
    const res = await preview('nobody');
    expect(res.status).toBe(404);
  });

  it('answers a repeat with 304 without synthesising again', async () => {
    tts.ready = true;
    const first = await preview('maya');
    const res = await request(app).get('/api/interviewers/maya/preview').set('Authorization', bearer).set('If-None-Match', first.headers.etag);
    expect([res.status, tts.voices.length]).toEqual([304, 1]);
  });

  it('gives each interviewer its own cache key', async () => {
    tts.ready = true;
    const a = await preview('maya');
    const b = await preview('theo');
    expect(a.headers.etag).not.toBe(b.headers.etag);
  });
});
