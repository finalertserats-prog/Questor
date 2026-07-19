import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import {
  ttsCapability,
  serverTtsReady,
  speechEtag,
  synthesizeServerSpeech,
  _resetSpeechCache,
} from '../src/providers/speech.js';

// ElevenLabs as a selectable interviewer voice.
//
// Unlike speech.test.ts, this file deliberately does NOT mock the provider
// module: the whole point is to prove the real dispatcher reaches ElevenLabs
// and inherits the cache, the in-flight dedupe and the fallback contract. The
// vendor is stubbed at `globalThis.fetch` instead, so nothing here can bill a
// real account even on a developer machine that has a live key in .env.
//
// `config` is a plain mutable object and the provider reads it per call, so the
// suite can point at elevenlabs without touching the pinned TTS_PROVIDER in
// vitest.config.ts (which keeps every OTHER file on the zero-key path).

const app = createApp();

const TEXT = 'Tell me about a system you designed under a hard deadline.';
const VOICE_A = 'voice-alpha-for-tests';
const VOICE_B = 'voice-beta-for-tests';

/** Records every outbound request so a test can assert who was actually called. */
interface VendorCall {
  url: string;
  body: Record<string, unknown>;
}

let calls: VendorCall[] = [];

function stubVendor(respond: () => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url: String(input), body });
    return respond();
  }) as typeof fetch;
}

function okAudio(): Response {
  // ID3-tagged MP3 bytes: the shape the connector claims to return.
  return new Response(Buffer.from('ID3fake-elevenlabs-audio'), { status: 200 });
}

let originalFetch: typeof globalThis.fetch;
let originalProvider: string;
let originalKey: string;
let originalVoice: string;
let originalEnvKey: string | undefined;
let originalEnvVoice: string | undefined;
let originalEnvModel: string | undefined;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  originalProvider = config.tts.provider;
  originalKey = config.tts.elevenKey;
  originalVoice = config.tts.elevenVoice;
  originalEnvKey = process.env.ELEVENLABS_API_KEY;
  originalEnvVoice = process.env.ELEVENLABS_VOICE_ID;
  originalEnvModel = process.env.ELEVENLABS_MODEL_ID;

  // Start every test from "elevenlabs selected, credential present", with the
  // env overrides cleared so a developer's own .env cannot change an assertion.
  config.tts.provider = 'elevenlabs';
  config.tts.elevenKey = 'test-key-not-a-real-credential';
  config.tts.elevenVoice = '';
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_VOICE_ID;
  delete process.env.ELEVENLABS_MODEL_ID;
  _resetSpeechCache();
});

afterEach(() => {
  _resetSpeechCache();
  globalThis.fetch = originalFetch;
  config.tts.provider = originalProvider;
  config.tts.elevenKey = originalKey;
  config.tts.elevenVoice = originalVoice;
  restoreEnv('ELEVENLABS_API_KEY', originalEnvKey);
  restoreEnv('ELEVENLABS_VOICE_ID', originalEnvVoice);
  restoreEnv('ELEVENLABS_MODEL_ID', originalEnvModel);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('ttsCapability — elevenlabs reporting', () => {
  it('reports configured when the key is present', () => {
    // The admin Connectors screen renders this: a wrong answer here tells an
    // operator their key did not take when it did.
    expect(ttsCapability()).toMatchObject({ provider: 'elevenlabs', mode: 'server', configured: true });
  });

  it('reports not configured when the key is absent', () => {
    config.tts.elevenKey = '';

    expect(ttsCapability().configured).toBe(false);
  });

  it('picks up a key supplied through the environment', () => {
    // config snapshots the variable at import, so an operator setting the key
    // after boot must still be seen as configured.
    config.tts.elevenKey = '';
    process.env.ELEVENLABS_API_KEY = 'late-key-not-a-real-credential';

    expect(ttsCapability().configured).toBe(true);
  });
});

describe('synthesizeServerSpeech — provider selection', () => {
  it('routes to ElevenLabs when TTS_PROVIDER=elevenlabs', async () => {
    // The regression this file exists for: the dispatcher used to reach OpenAI
    // regardless, so setting TTS_PROVIDER=elevenlabs produced no ElevenLabs
    // audio at all.
    stubVendor(okAudio);

    const speech = await synthesizeServerSpeech(TEXT);

    expect(speech).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('api.elevenlabs.io');
    expect(calls[0].url).not.toContain('api.openai.com');
  });

  it('sends a model the vendor still supports', async () => {
    // eleven_turbo_v2, which this connector shipped with, is deprecated.
    stubVendor(okAudio);

    await synthesizeServerSpeech(TEXT);

    expect(calls[0].body.model_id).toBe('eleven_multilingual_v2');
  });

  it('honours ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL_ID overrides', async () => {
    process.env.ELEVENLABS_VOICE_ID = VOICE_A;
    process.env.ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';
    stubVendor(okAudio);

    await synthesizeServerSpeech(TEXT);

    expect(calls[0].url).toContain(VOICE_A);
    expect(calls[0].body.model_id).toBe('eleven_flash_v2_5');
  });

  it('returns audio tagged as mpeg so the client can play it', async () => {
    stubVendor(okAudio);

    const speech = await synthesizeServerSpeech(TEXT);

    expect(speech?.contentType).toBe('audio/mpeg');
    expect(speech?.audio.byteLength).toBeGreaterThan(0);
  });
});

describe('synthesizeServerSpeech — missing key falls back', () => {
  it('returns null rather than throwing when no key is configured', async () => {
    // The zero-key contract: a caller must be able to say "use browser speech"
    // instead of failing. Throwing here would surface as a 500 mid-interview.
    config.tts.elevenKey = '';
    stubVendor(okAudio);

    await expect(synthesizeServerSpeech(TEXT)).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('does not consider itself ready without a key', () => {
    config.tts.elevenKey = '';

    expect(serverTtsReady()).toBe(false);
  });
});

describe('speech cache — ElevenLabs path', () => {
  it('serves a repeated question from cache instead of re-billing', async () => {
    // An interview replays the same handful of questions; every extra call is
    // charged per character.
    stubVendor(okAudio);

    await synthesizeServerSpeech(TEXT);
    await synthesizeServerSpeech(TEXT);
    await synthesizeServerSpeech(TEXT);

    expect(calls).toHaveLength(1);
  });

  it('collapses concurrent misses onto one vendor call', async () => {
    stubVendor(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return okAudio();
    });

    await Promise.all(Array.from({ length: 8 }, () => synthesizeServerSpeech(TEXT)));

    expect(calls).toHaveLength(1);
  });

  it('does not serve the previous voice after the voice changes', async () => {
    // The failure this guards against is silent: switching ELEVENLABS_VOICE_ID
    // would keep playing the old voice's audio, which looks exactly like the
    // setting being ignored.
    stubVendor(okAudio);

    process.env.ELEVENLABS_VOICE_ID = VOICE_A;
    await synthesizeServerSpeech(TEXT);
    process.env.ELEVENLABS_VOICE_ID = VOICE_B;
    await synthesizeServerSpeech(TEXT);

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain(VOICE_B);
  });

  it('gives different voices different ETags for the same text', () => {
    process.env.ELEVENLABS_VOICE_ID = VOICE_A;
    const first = speechEtag(TEXT);
    process.env.ELEVENLABS_VOICE_ID = VOICE_B;

    expect(speechEtag(TEXT)).not.toBe(first);
  });

  it('gives different models different ETags for the same text', () => {
    process.env.ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';
    const first = speechEtag(TEXT);
    process.env.ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';

    expect(speechEtag(TEXT)).not.toBe(first);
  });

  it('gives different providers different ETags for the same text', () => {
    const eleven = speechEtag(TEXT);
    config.tts.provider = 'openai';

    expect(speechEtag(TEXT)).not.toBe(eleven);
  });

  it('does not cache a failed synthesis', async () => {
    // A wedged in-flight slot or a cached failure would turn one vendor blip
    // into a permanently voiceless question.
    stubVendor(() => new Response('upstream boom', { status: 500 }));
    await expect(synthesizeServerSpeech(TEXT)).rejects.toThrow();

    stubVendor(okAudio);
    const recovered = await synthesizeServerSpeech(TEXT);

    expect(recovered).not.toBeNull();
  });
});

describe('POST /api/portal/:token/speak — ElevenLabs end to end', () => {
  let token = '';
  let agentTurnId = '';

  beforeAll(async () => {
    await wipe();
    const demo = await createDemoData();
    token = demo.token;
    const turn = await prisma.turn.create({
      data: { sessionId: demo.sessionId, index: 0, speaker: 'agent', text: TEXT, competencyId: 'data-eng' },
    });
    agentTurnId = turn.id;
  });

  it('returns ElevenLabs audio for a real agent turn', async () => {
    stubVendor(okAudio);

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: agentTurnId });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(calls[0].url).toContain('api.elevenlabs.io');
  });

  it('falls back to 204 browser speech when the vendor errors', async () => {
    // The requirement that matters most: a voice vendor being down must never
    // stall the interview. 204 means "use browser speechSynthesis".
    stubVendor(() => new Response('service unavailable', { status: 503 }));

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: agentTurnId });

    expect(res.status).toBe(204);
  });

  it('falls back to 204 when the vendor connection fails outright', async () => {
    // A rejected fetch (DNS, TLS, socket) is a different path from an error
    // status, and must not surface as a 500 either.
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: agentTurnId });

    expect(res.status).toBe(204);
  });

  it('falls back to 204 when elevenlabs is selected but unconfigured', async () => {
    config.tts.elevenKey = '';
    stubVendor(okAudio);

    const res = await request(app).post(`/api/portal/${token}/speak`).send({ turnId: agentTurnId });

    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it('still refuses arbitrary text on the ElevenLabs path', async () => {
    // The spend control must not weaken just because the provider changed.
    stubVendor(okAudio);

    const res = await request(app)
      .post(`/api/portal/${token}/speak`)
      .send({ text: 'Read my arbitrary paragraph aloud.' });

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});
