import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import {
  INTERVIEWER_DELIVERY,
  serverTtsReady,
  speechEtag,
  synthesizeServerSpeech,
  _resetSpeechCache,
  type VoiceSelection,
} from '../src/providers/speech.js';
import { VOICE_PROFILE_CATALOGUE, defaultVoiceFor } from '../src/domain/interviewerModel.js';

// Each interviewer speaks with its own voice, and a voice profile's provider is
// honoured per interviewer. Vendors are stubbed at fetch, so nothing here can
// bill a real account.

interface VendorCall { url: string; body: Record<string, unknown> }
let calls: VendorCall[] = [];
let originalFetch: typeof globalThis.fetch;
const saved = { provider: '', openaiKey: '', elevenKey: '', elevenVoice: '' };
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['OPENAI_TTS_VOICE', 'OPENAI_TTS_MODEL', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL_ID'];

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url: String(input), body });
    return new Response(Buffer.from('ID3fake-audio'), { status: 200 });
  }) as typeof fetch;
  saved.provider = config.tts.provider;
  saved.openaiKey = config.llm.openaiKey;
  saved.elevenKey = config.tts.elevenKey;
  saved.elevenVoice = config.tts.elevenVoice;
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  config.tts.provider = 'openai';
  config.llm.openaiKey = 'test-openai-key-not-real';
  config.tts.elevenKey = '';
  config.tts.elevenVoice = '';
  _resetSpeechCache();
});

afterEach(() => {
  _resetSpeechCache();
  globalThis.fetch = originalFetch;
  config.tts.provider = saved.provider;
  config.llm.openaiKey = saved.openaiKey;
  config.tts.elevenKey = saved.elevenKey;
  config.tts.elevenVoice = saved.elevenVoice;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const TEXT = 'Tell me about a pipeline you owned end to end.';
const openai = (voiceId: string): VoiceSelection => ({ provider: 'openai', voiceId });

describe('OpenAI voice per interviewer', () => {
  it('synthesizes with the interviewer voice rather than the global default', async () => {
    await synthesizeServerSpeech(TEXT, openai('coral'));
    expect(calls[0].body.voice).toBe('coral');
  });

  it('uses gpt-4o-mini-tts, the model that takes delivery instructions', async () => {
    await synthesizeServerSpeech(TEXT, openai('coral'));
    expect(calls[0].body.model).toBe('gpt-4o-mini-tts');
  });

  it('falls back to the configured voice when the profile has none', async () => {
    process.env.OPENAI_TTS_VOICE = 'verse';
    await synthesizeServerSpeech(TEXT, { provider: 'openai', voiceId: '' });
    expect(calls[0].body.voice).toBe('verse');
  });

  it('sends one identical delivery instruction for all five interviewers', async () => {
    for (const profile of VOICE_PROFILE_CATALOGUE) {
      await synthesizeServerSpeech(TEXT, openai(defaultVoiceFor(profile.id, 'openai')));
    }
    expect(new Set(calls.map((c) => c.body.instructions))).toEqual(new Set([INTERVIEWER_DELIVERY]));
  });

  it('keeps tone out of the delivery instruction, since Tone is a separate setting', () => {
    expect(INTERVIEWER_DELIVERY.toLowerCase()).not.toMatch(/warm|friendly|formal|neutral|strict|stern|encouraging|cheerful|bubbly|kind|firm/);
  });
});

describe('provider per voice profile', () => {
  it('routes an ElevenLabs profile to ElevenLabs while the default provider is OpenAI', async () => {
    config.tts.elevenKey = 'test-eleven-key-not-real';
    await synthesizeServerSpeech(TEXT, { provider: 'elevenlabs', voiceId: 'elevenVoiceForTests' });
    expect(calls[0].url).toContain('/v1/text-to-speech/elevenVoiceForTests');
  });

  it('falls back to the configured provider when the profile provider has no credential', async () => {
    await synthesizeServerSpeech(TEXT, { provider: 'elevenlabs', voiceId: 'elevenVoiceForTests' });
    expect(calls[0].url).toContain('api.openai.com');
  });

  it('counts server speech as ready when only the profile provider is configured', () => {
    config.tts.provider = 'webspeech';
    config.tts.elevenKey = 'test-eleven-key-not-real';
    expect(serverTtsReady({ provider: 'elevenlabs', voiceId: 'elevenVoiceForTests' })).toBe(true);
  });

  it('is not ready for a provider with no connector and no configured default', () => {
    config.tts.provider = 'webspeech';
    expect(serverTtsReady({ provider: 'azure', voiceId: 'x1' })).toBe(false);
  });
});

describe('cache keys per voice', () => {
  it('gives two interviewer voices different ETags for the same text', () => {
    expect(speechEtag(TEXT, openai('marin'))).not.toBe(speechEtag(TEXT, openai('cedar')));
  });

  it('never serves one voice the audio cached for another', async () => {
    await synthesizeServerSpeech(TEXT, openai('marin'));
    await synthesizeServerSpeech(TEXT, openai('cedar'));
    expect(calls.map((c) => c.body.voice)).toEqual(['marin', 'cedar']);
  });

  it('keys the ETag with a server secret, so a client cannot work out which voice produced it', () => {
    const fields = ['openai', 'gpt-4o-mini-tts', 'marin', TEXT].join(String.fromCharCode(0));
    const plain = createHash('sha256').update(fields).digest('hex').slice(0, 32);
    expect(speechEtag(TEXT, openai('marin'))).not.toBe(`"${plain}"`);
  });

  it('keeps the ETag stable for the same voice and text', () => {
    expect(speechEtag(TEXT, openai('marin'))).toBe(speechEtag(TEXT, openai('marin')));
  });

  it('serves a repeat for the same voice from cache', async () => {
    await synthesizeServerSpeech(TEXT, openai('marin'));
    await synthesizeServerSpeech(TEXT, openai('marin'));
    expect(calls).toHaveLength(1);
  });
});
