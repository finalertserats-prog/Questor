import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

// The portal /transcribe route is unauthenticated and every call is billed per
// MINUTE OF AUDIO — the most expensive unauthenticated surface in the app.
// These tests pin the controls that stop it becoming a free transcription API
// for the internet, plus the zero-key fallback that keeps the open build usable.
//
// The provider layer is stubbed rather than left to ambient configuration, for
// the same two reasons as speech.test.ts: a developer with a real STT_PROVIDER +
// OPENAI_API_KEY in their .env would otherwise have this suite bill their
// account on every run, and the "no server STT" assertions would silently
// invert into passing-by-accident.
const sttStub = vi.hoisted(() => ({
  ready: false,
  text: null as string | null,
  throws: false,
}));

vi.mock('../src/providers/speech.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/speech.js')>();
  return {
    ...actual,
    serverSttReady: () => sttStub.ready,
    transcribeServerSpeech: async () => {
      if (sttStub.throws) throw new Error('vendor exploded');
      return sttStub.text;
    },
  };
});

const app = createApp();

let token = '';
let sessionId = '';

// A WebM/Matroska file opens with the EBML header; the route sniffs these bytes
// rather than trusting the declared Content-Type, so a valid-shaped clip is
// required to reach any of the logic past the upload gate.
const WEBM_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 0x42)]);

function postAudio(withToken: string, bytes: Buffer = WEBM_BYTES, contentType = 'audio/webm') {
  return request(app)
    .post(`/api/portal/${withToken}/transcribe`)
    .attach('audio', bytes, { filename: 'answer.webm', contentType });
}

beforeAll(async () => {
  await wipe();
  const demo = await createDemoData();
  token = demo.token;
  sessionId = demo.sessionId;

  // The demo session is seeded as ACCEPTED. Transcription is only offered
  // mid-interview, so move it into a live state for the tests that need to
  // reach past the state gate.
  await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: 'ASSESSING' } });
});

beforeEach(() => {
  // Default to the zero-key build: the open path is the one that must never rot.
  sttStub.ready = false;
  sttStub.text = null;
  sttStub.throws = false;
});

describe('POST /api/portal/:token/transcribe — invitation gate', () => {
  it('rejects an unknown invitation token', async () => {
    const res = await postAudio('definitely-not-a-real-token');
    expect(res.status).toBe(404);
  });

  it('rejects an expired invitation token', async () => {
    const original = await prisma.invitation.findUnique({ where: { sessionId } });
    await prisma.invitation.update({
      where: { sessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const res = await postAudio(token);
    expect(res.status).toBe(410);

    await prisma.invitation.update({ where: { sessionId }, data: { expiresAt: original!.expiresAt } });
  });

  it('rejects a consumed invitation token', async () => {
    // Finalising an interview consumes its invitation; a consumed token must not
    // keep billing us for transcription after the interview is over.
    await prisma.invitation.update({ where: { sessionId }, data: { status: 'consumed' } });

    const res = await postAudio(token);
    expect(res.status).toBe(410);

    await prisma.invitation.update({ where: { sessionId }, data: { status: 'accepted' } });
  });
});

describe('POST /api/portal/:token/transcribe — upload gate', () => {
  it('rejects a non-audio content type', async () => {
    // A PDF posted at the transcription endpoint is either a bug or someone
    // probing for a free file-processing API. Either way it never reaches a
    // paid vendor.
    const res = await postAudio(token, Buffer.from('%PDF-1.7 not audio at all'), 'application/pdf');
    expect(res.status).toBe(400);
  });

  it('rejects audio whose bytes disagree with the declared type', async () => {
    // The declared Content-Type is chosen by the uploader, so the allowlist
    // alone proves nothing — this is the check that makes it mean something.
    const res = await postAudio(token, Buffer.from('this is plain text pretending to be webm'));
    expect(res.status).toBe(400);
  });

  it('rejects an oversized upload', async () => {
    // Billed per minute of audio, so the byte cap is a spend control, not just
    // a memory control. Rejected by multer before the body is fully buffered.
    const oversized = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.alloc(11 * 1024 * 1024, 0x42),
    ]);

    const res = await postAudio(token, oversized);
    expect(res.status).toBe(400);
  });

  it('rejects a request with no audio attached', async () => {
    const res = await request(app).post(`/api/portal/${token}/transcribe`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/portal/:token/transcribe — interview state gate', () => {
  it('refuses to transcribe for an interview that is not live', async () => {
    // A finished interview cannot produce a new answer, so paying to transcribe
    // audio for one is spend no reviewer will ever read.
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: 'REVIEW_READY' } });

    const res = await postAudio(token);
    expect(res.status).toBe(409);

    await prisma.interviewSession.update({ where: { id: sessionId }, data: { state: 'ASSESSING' } });
  });
});

describe('POST /api/portal/:token/transcribe — zero-key fallback', () => {
  it('returns 204 when no server STT is configured', async () => {
    // 204, not an error: the client treats this as "use browser
    // SpeechRecognition", which is what keeps the zero-key build functional.
    const res = await postAudio(token);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('falls back to 204 rather than erroring when the vendor fails', async () => {
    // A vendor outage must not strand a candidate mid-answer.
    sttStub.ready = true;
    sttStub.throws = true;

    const res = await postAudio(token);
    expect(res.status).toBe(204);
  });
});

describe('POST /api/portal/:token/transcribe — with a server provider configured', () => {
  beforeEach(() => {
    sttStub.ready = true;
    sttStub.text = 'I owned the ingestion pipeline end to end.';
  });

  it('returns the transcript for a valid audio upload', async () => {
    const res = await postAudio(token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'I owned the ingestion pipeline end to end.' });
  });

  it('still rejects a forged content type when transcription is live', async () => {
    // The control that actually bounds spend, asserted on the path where money
    // would really be spent.
    const res = await postAudio(token, Buffer.from('not audio'), 'audio/webm');
    expect(res.status).toBe(400);
  });
});
