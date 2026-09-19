import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

/**
 * When transcription is down, the round carries on and the observer says it
 * could not capture that stretch. It never fills the gap with anything.
 *
 * The server speech provider is mocked: a server STT is "configured" and every
 * call fails, as it would during a vendor outage.
 */

const transcribe = vi.fn<(audio: Buffer, mime: string) => Promise<string | null>>();

vi.mock('../src/providers/speech.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/speech.js')>();
  return {
    ...actual,
    serverSttReady: () => true,
    sttCapability: () => ({ provider: 'whisper', mode: 'server', configured: true, streaming: false, languages: ['multi'], notes: '' }),
    transcribeServerSpeech: (audio: Buffer, mime: string) => transcribe(audio, mime),
  };
});

const { createApp } = await import('../src/app.js');
const { wipe } = await import('../src/seed/demoData.js');
const { listening, observationOf, seededObserver } = await import('./observerHelpers.js');

const app = createApp();
// A minimal WebM (EBML) header: enough for the container sniff.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 1)]);

function sendAudio(auth: string, roundId: string, offsetMs = 0) {
  return request(app).post(`/api/observer/rounds/${roundId}/segments`).set('Authorization', auth)
    .field('offsetMs', String(offsetMs)).field('durationMs', '30000')
    .attach('audio', WEBM, { filename: 'chunk.webm', contentType: 'audio/webm' });
}

describe('capture during a transcription outage', () => {
  beforeEach(async () => {
    await wipe();
    transcribe.mockReset();
  });

  it('keeps the round going when transcription fails', async () => {
    transcribe.mockRejectedValue(new Error('vendor 503'));
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);

    const res = await sendAudio(ids.auth, roundId);

    expect(res.status).toBe(200);
    expect(res.body.captured).toBe(false);
  });

  it('records a gap, with no invented words, where transcription failed', async () => {
    transcribe.mockRejectedValue(new Error('vendor 503'));
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await sendAudio(ids.auth, roundId, 30_000);

    const observation = await observationOf(roundId);

    expect(observation.segments).toEqual([expect.objectContaining({ kind: 'GAP', text: '', offsetMs: 30_000 })]);
    expect(observation.captureStatus).toBe('DEGRADED');
    expect((await observationOf(roundId)).status).toBe('LISTENING');
  });

  it('transcribes audio on the server when the provider answers', async () => {
    transcribe.mockResolvedValue('We partitioned the table by month.');
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);

    const res = await sendAudio(ids.auth, roundId);

    expect(res.status).toBe(201);
    expect((await observationOf(roundId)).segments[0].text).toBe('We partitioned the table by month.');
  });

  it('does not pay to transcribe audio for a round that is not listening', async () => {
    transcribe.mockResolvedValue('Should never be requested.');
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);
    await request(app).post(`/api/observer/rounds/${roundId}/stop`).set('Authorization', ids.auth).send({});

    await sendAudio(ids.auth, roundId);

    expect(transcribe).not.toHaveBeenCalled();
  });

  it('refuses bytes that are not the audio they claim to be', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);

    const res = await request(app).post(`/api/observer/rounds/${roundId}/segments`).set('Authorization', ids.auth)
      .field('offsetMs', '0').attach('audio', Buffer.from('not audio at all'), { filename: 'x.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(400);
  });

  it('lets the room report a stretch its own microphone could not capture', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);

    const res = await request(app).post(`/api/observer/rounds/${roundId}/capture-gap`).set('Authorization', ids.auth)
      .send({ offsetMs: 0, durationMs: 15_000, reason: 'microphone-unavailable' });

    expect(res.status).toBe(201);
    expect((await observationOf(roundId)).captureStatus).toBe('DEGRADED');
  });

  it('tells the room to capture on the server when a server provider is ready', async () => {
    const ids = await seededObserver(app);
    const { roundId } = await listening(app, ids);

    const res = await request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', ids.auth);

    expect(res.body.capture.mode).toBe('server');
  });
});
