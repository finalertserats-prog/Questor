import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Speech provider descriptors. The default `webspeech` runs entirely in the
// candidate's browser (SpeechRecognition + speechSynthesis) — zero keys, open.
// Paid connectors advertise their capabilities and required credentials so the
// client can switch transports once a license key is present.

export interface SpeechCapability {
  provider: string;
  mode: 'browser' | 'server';
  configured: boolean;
  streaming: boolean;
  languages: string[];
  notes: string;
}

export function sttCapability(): SpeechCapability {
  switch (config.stt.provider) {
    case 'deepgram':
      return { provider: 'deepgram', mode: 'server', configured: !!config.stt.deepgramKey, streaming: true, languages: ['en', 'multi'], notes: 'Deepgram streaming ASR. Set DEEPGRAM_API_KEY.' };
    case 'whisper':
      // Provider id stays `whisper` for continuity with STT_PROVIDER, but the
      // model behind it is gpt-4o-transcribe — see transcribeOpenAI.
      return { provider: 'whisper', mode: 'server', configured: !!config.llm.openaiKey, streaming: false, languages: ['multi'], notes: 'OpenAI batch transcription. Reuses OPENAI_API_KEY.' };
    case 'azure':
      return { provider: 'azure', mode: 'server', configured: !!config.stt.azureKey, streaming: true, languages: ['multi'], notes: 'Azure Speech. Set AZURE_SPEECH_KEY + region.' };
    default:
      return { provider: 'webspeech', mode: 'browser', configured: true, streaming: true, languages: ['en'], notes: 'Browser-native SpeechRecognition. No key required.' };
  }
}

export function ttsCapability(): SpeechCapability {
  switch (config.tts.provider) {
    case 'elevenlabs':
      return { provider: 'elevenlabs', mode: 'server', configured: elevenLabsConfigured(), streaming: true, languages: ['multi'], notes: 'ElevenLabs neural voices. Set ELEVENLABS_API_KEY. Materially pricier than OpenAI TTS.' };
    case 'openai':
      return { provider: 'openai', mode: 'server', configured: !!config.llm.openaiKey, streaming: true, languages: ['multi'], notes: 'OpenAI TTS voices.' };
    case 'azure':
      return { provider: 'azure', mode: 'server', configured: !!config.stt.azureKey, streaming: true, languages: ['multi'], notes: 'Azure neural TTS.' };
    default:
      return { provider: 'webspeech', mode: 'browser', configured: true, streaming: true, languages: ['en'], notes: 'Browser-native speechSynthesis. No key required.' };
  }
}

// --------------------------------------------------------------------------
// ElevenLabs TTS
// --------------------------------------------------------------------------

// Model and voice are read lazily from the environment rather than added to
// config.ts, matching the OpenAI connector below so this connector stays
// self-contained. The env is consulted BEFORE `config.tts`, which snapshots the
// same variable at import: reading it live keeps a late override honoured
// instead of frozen at process start.
//
// Model: eleven_multilingual_v2. This connector shipped with eleven_turbo_v2,
// which ElevenLabs' own model docs now list as DEPRECATED; their changelog
// makes eleven_multilingual_v2 the default model for the text-to-speech
// endpoints, and it is the model in their current API examples. Of the live
// tiers, the flash/turbo models trade fidelity for ~75ms latency at half the
// credit price, while multilingual_v2 is documented as the long-form-stable,
// high-fidelity tier. An interview question is synthesized ONCE and then served
// from the cache below on every repeat, so latency is a one-off cost on first
// play whereas the timbre is heard by every candidate — that trade favours
// fidelity. Set ELEVENLABS_MODEL_ID=eleven_flash_v2_5 to take the cheaper,
// faster tier instead.
const DEFAULT_ELEVENLABS_MODEL = 'eleven_multilingual_v2';

// Voice: George. ElevenLabs uses this id throughout its own current
// text-to-speech examples, so it is a premade voice present on every account
// rather than one a tenant has to add to their library first — a default that
// 404s on a fresh account would look like the connector is broken. It reads as
// a warm, measured, mid-range narrator rather than a bright announcer or a
// newsreader, which is what an interview wants: the candidate is already
// nervous, and an over-energetic voice reads as a sales bot. Same reasoning as
// the OpenAI `marin` default below. Tenants who want a different persona set
// ELEVENLABS_VOICE_ID; operators should audition it before going live, since
// voice choice is a product decision, not a technical one.
const DEFAULT_ELEVENLABS_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

/**
 * MP3 at 44.1kHz/128kbps — the endpoint's own default, sent explicitly because
 * `contentType` is hardcoded to audio/mpeg downstream. If the vendor ever moves
 * its default to another codec, an implicit format would leave us serving
 * mislabelled bytes that the browser silently refuses to play.
 */
const ELEVENLABS_OUTPUT_FORMAT = 'mp3_44100_128';

/** The model's documented input ceiling; callers cap far below this for spend reasons. */
const ELEVENLABS_MAX_INPUT_CHARS = 10_000;

function elevenLabsModel(): string {
  return process.env.ELEVENLABS_MODEL_ID || DEFAULT_ELEVENLABS_MODEL;
}

function elevenLabsVoice(): string {
  return process.env.ELEVENLABS_VOICE_ID || config.tts.elevenVoice || DEFAULT_ELEVENLABS_VOICE;
}

/**
 * True when ElevenLabs actually has its credential.
 *
 * Read live rather than off the import-time snapshot because the admin
 * Connectors screen renders this: a stale `false` there tells an operator their
 * key did not take when it did, and a stale `true` promises a voice that will
 * 401 on the first question.
 */
function elevenLabsConfigured(): boolean {
  return !!(process.env.ELEVENLABS_API_KEY || config.tts.elevenKey);
}

/**
 * Server-side ElevenLabs TTS connector (returns audio bytes). Only used when
 * TTS_PROVIDER=elevenlabs and a key is present; the browser falls back to
 * speechSynthesis otherwise.
 */
export async function synthesizeElevenLabs(text: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY || config.tts.elevenKey;
  if (!apiKey) throw new Error('ElevenLabs not configured');

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenLabsVoice())}`
    + `?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: text.slice(0, ELEVENLABS_MAX_INPUT_CHARS),
      model_id: elevenLabsModel(),
      // ElevenLabs has no equivalent of OpenAI's `instructions` prompt, so
      // delivery is steered through these instead. Vendor-documented starting
      // points (stability 0.5, similarity 0.75, style 0); style is left at 0
      // because amplifying a voice's own style is what pushes it towards
      // performance, and it costs latency. speaker boost is off for the same
      // latency reason — it sharpens similarity to the source recording, which
      // buys nothing on a premade voice.
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: false,
        // Slightly under real-time, matching the OpenAI path: interview
        // questions land better with a beat of space, and it gives the
        // candidate time to parse a long question.
        speed: 0.95,
      },
    }),
  });
  // Same reasoning as synthesizeOpenAI: the upstream body never enters the
  // thrown message, because this is reached from an unauthenticated route.
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --------------------------------------------------------------------------
// OpenAI TTS
// --------------------------------------------------------------------------

// Model and voice are read lazily from the environment rather than added to
// config.ts so this connector stays self-contained; hoist them into
// `config.tts` when that file is next touched.
//
// Model: gpt-4o-mini-tts. The older tts-1 / tts-1-hd models cannot be steered
// and cannot use the newer voices; gpt-4o-mini-tts accepts an `instructions`
// prompt, which is what actually moves the delivery from "screen reader" to
// "person conducting an interview".
//
// Voice: marin. OpenAI documents marin and cedar as its highest-quality voices,
// and both are exclusive to gpt-4o-mini-tts. Between the two, marin reads warm
// and even-paced rather than bright or announcer-like — a candidate is already
// nervous, and an over-energetic voice reads as a sales bot. marin is also
// gender-neutral enough not to impose a persona the tenant did not choose.
const DEFAULT_OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_OPENAI_TTS_VOICE = 'marin';

// Steers prosody, not wording. The complaint that prompted this was "looks like
// a bot", which is mostly pace and pausing rather than timbre.
const INTERVIEWER_STYLE =
  'Speak as a warm, calm, professional human interviewer. Natural conversational pace, ' +
  'slightly slower than average. Pause briefly at commas and between sentences. ' +
  'Friendly and encouraging but not bubbly or salesy. Do not sound like a narrator or an announcer.';

/** The API rejects anything longer; callers cap far below this for spend reasons. */
const OPENAI_TTS_MAX_INPUT_CHARS = 4096;

function openAiTtsModel(): string {
  return process.env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_TTS_MODEL;
}

function openAiTtsVoice(): string {
  return process.env.OPENAI_TTS_VOICE || DEFAULT_OPENAI_TTS_VOICE;
}

/**
 * Server-side OpenAI TTS connector (returns audio bytes). Only used when
 * TTS_PROVIDER=openai and OPENAI_API_KEY is present; the browser falls back to
 * speechSynthesis otherwise.
 */
export async function synthesizeOpenAI(text: string): Promise<Buffer> {
  if (!config.llm.openaiKey) throw new Error('OpenAI TTS not configured');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.llm.openaiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: openAiTtsModel(),
      voice: openAiTtsVoice(),
      input: text.slice(0, OPENAI_TTS_MAX_INPUT_CHARS),
      instructions: INTERVIEWER_STYLE,
      response_format: 'mp3',
      // Slightly under real-time. Interview questions land better with a beat of
      // space, and it gives the candidate time to parse a long question.
      speed: 0.95,
    }),
  });
  // Deliberately does not include the upstream body in the thrown message: this
  // is reached from an unauthenticated route, and errorHandler only surfaces
  // HttpError messages, so an upstream body here would only ever reach the log.
  if (!res.ok) throw new Error(`OpenAI TTS error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --------------------------------------------------------------------------
// OpenAI STT (transcription)
// --------------------------------------------------------------------------

// Model is read lazily from the environment for the same reason as the TTS
// model above: this connector stays self-contained until config.ts is next
// touched.
//
// Model: gpt-4o-transcribe. The `whisper` provider name is kept for continuity
// with sttCapability() and STT_PROVIDER, but whisper-1 is no longer the right
// endpoint behind it. On OpenAI's own listing the gpt-4o transcription models
// supersede whisper-1 on word error rate — notably on accented English and on
// the short, disfluent utterances an interview actually produces ("so, um, the
// thing I owned was...") — at the same per-minute price, so staying on
// whisper-1 would buy nothing.
//
// gpt-4o-transcribe over gpt-4o-mini-transcribe: an interview answer is
// transcribed exactly once and the text becomes hiring evidence that a human
// reads and an LLM scores. A mis-transcribed competency term is a scoring
// error we never see, which is far more expensive than the price gap on a
// 30-second clip. Latency between the two is a fraction of a second on
// utterances this short, so accuracy is the only axis that matters here.
//
// gpt-4o-transcribe-diarize is deliberately NOT used: it costs more and solves
// multi-speaker attribution, which does not apply — each upload is one
// candidate's single answer from their own microphone.
const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-transcribe';

function openAiSttModel(): string {
  return process.env.OPENAI_STT_MODEL || DEFAULT_OPENAI_STT_MODEL;
}

/**
 * Container types the candidate's browser can realistically produce, mapped to
 * the file extension OpenAI's endpoint uses to pick a demuxer.
 *
 * The endpoint dispatches on the FILENAME, not on any content type we send, so
 * an upload arriving as `audio/ogg` must be handed over as `.ogg` or it is
 * rejected as unreadable even though the bytes are fine.
 */
const OPENAI_STT_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'video/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'video/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
};

/**
 * MediaRecorder reports codecs inline (`audio/webm;codecs=opus`). The parameter
 * is meaningful to the browser but not to our lookup, so strip it before
 * matching rather than widening every key into a prefix test.
 */
export function normalizeAudioMimeType(value: string): string {
  return value.split(';')[0].trim().toLowerCase();
}

/** True when the container is one both the browser produces and OpenAI accepts. */
export function isTranscribableMimeType(value: string): boolean {
  return normalizeAudioMimeType(value) in OPENAI_STT_EXTENSIONS;
}

// Container signatures, keyed by the extension the mime map resolves to.
// Matroska/WebM opens with an EBML header; Ogg with its capture pattern; MP4
// and M4A carry `ftyp` at offset 4 rather than offset 0; WAV is a RIFF form
// whose type field must read WAVE.
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const OGG_MAGIC = Buffer.from('OggS', 'ascii');
const FTYP_MAGIC = Buffer.from('ftyp', 'ascii');
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WAVE_MAGIC = Buffer.from('WAVE', 'ascii');
const ID3_MAGIC = Buffer.from('ID3', 'ascii');

function hasMagicAt(buffer: Buffer, magic: Buffer, offset: number): boolean {
  return buffer.length >= offset + magic.length && buffer.subarray(offset, offset + magic.length).equals(magic);
}

/** A bare MPEG audio frame: 11 sync bits, no container header to match on. */
function isMpegFrameSync(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

/**
 * Confirm the bytes are the container the upload claims to be.
 *
 * The declared Content-Type is chosen by the uploader, so on its own it only
 * says what someone wants us to believe. Without this check the mime allowlist
 * is a formality: anything at all could be posted as `audio/webm` and forwarded
 * to a paid vendor. Mirrors the sniff-and-compare rule in resumeParser, for the
 * same reason — the declared type must agree with the sniffed type, never
 * merely be present.
 */
export function audioBytesMatchMimeType(buffer: Buffer, mimeType: string): boolean {
  const extension = OPENAI_STT_EXTENSIONS[normalizeAudioMimeType(mimeType)];
  switch (extension) {
    case 'webm':
      return hasMagicAt(buffer, EBML_MAGIC, 0);
    case 'ogg':
      return hasMagicAt(buffer, OGG_MAGIC, 0);
    case 'mp4':
    case 'm4a':
      return hasMagicAt(buffer, FTYP_MAGIC, 4);
    case 'wav':
      return hasMagicAt(buffer, RIFF_MAGIC, 0) && hasMagicAt(buffer, WAVE_MAGIC, 8);
    case 'mp3':
      // ID3-tagged files and raw MPEG streams are both common in the wild.
      return hasMagicAt(buffer, ID3_MAGIC, 0) || isMpegFrameSync(buffer);
    default:
      return false;
  }
}

/**
 * Server-side OpenAI transcription connector. Only used when STT_PROVIDER=whisper
 * and OPENAI_API_KEY is present; the browser falls back to SpeechRecognition
 * otherwise.
 */
export async function transcribeOpenAI(audio: Buffer, mimeType: string): Promise<string> {
  if (!config.llm.openaiKey) throw new Error('OpenAI STT not configured');
  const normalized = normalizeAudioMimeType(mimeType);
  const extension = OPENAI_STT_EXTENSIONS[normalized];
  if (!extension) throw new Error(`Unsupported audio type ${normalized}`);

  const form = new FormData();
  // Buffer -> Uint8Array copy because Blob rejects Node's Buffer view directly
  // under exactOptionalPropertyTypes-strict lib typings.
  form.append('file', new Blob([new Uint8Array(audio)], { type: normalized }), `answer.${extension}`);
  form.append('model', openAiSttModel());
  // The interview is conducted in one known language, so pinning it stops the
  // model from "detecting" a different language on a short or noisy clip and
  // returning a confident translation of something the candidate never said.
  form.append('language', 'en');
  // Plain text: we want the utterance, not segments or timings. The route's
  // caller already tracks turn boundaries itself.
  form.append('response_format', 'text');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    // No content-type header: fetch must set the multipart boundary itself.
    headers: { authorization: `Bearer ${config.llm.openaiKey}` },
    body: form,
  });
  // Same reasoning as synthesizeOpenAI: the upstream body never enters the
  // thrown message, because this is reached from an unauthenticated route.
  if (!res.ok) throw new Error(`OpenAI STT error ${res.status}`);
  return (await res.text()).trim();
}

/** True when a *server-side* STT provider is selected AND has its credential. */
export function serverSttReady(): boolean {
  const cap = sttCapability();
  return cap.mode === 'server' && cap.configured;
}

/**
 * Transcribe via whichever server provider is configured.
 *
 * Returns null when no server provider is available so callers can signal "use
 * browser SpeechRecognition" instead of failing — the same zero-key contract
 * synthesizeServerSpeech honours. Deliberately uncached, unlike TTS: every
 * upload is a distinct utterance, so a cache would only ever hold misses while
 * retaining candidate audio in memory.
 */
export async function transcribeServerSpeech(audio: Buffer, mimeType: string): Promise<string | null> {
  if (!serverSttReady()) return null;

  switch (config.stt.provider) {
    case 'whisper':
      return transcribeOpenAI(audio, mimeType);
    default:
      // `serverSttReady` admits deepgram and azure, which have no connector
      // yet. Falling back to browser speech is correct here; throwing would
      // break the interview.
      logger.warn({ provider: config.stt.provider }, 'No server STT connector for configured provider');
      return null;
  }
}

// --------------------------------------------------------------------------
// Cached dispatch
// --------------------------------------------------------------------------

export interface SynthesizedSpeech {
  audio: Buffer;
  contentType: string;
  /** Strong validator over (provider, model, voice, text) — safe to hand to a client. */
  etag: string;
}

/** True when a *server-side* TTS provider is selected AND has its credential. */
export function serverTtsReady(): boolean {
  const cap = ttsCapability();
  return cap.mode === 'server' && cap.configured;
}

/**
 * Cache key must cover everything that changes the audio, or a voice/model swap
 * would keep serving the previous rendering under the same ETag.
 *
 * Fields are joined on NUL because it is the one character that cannot occur in
 * a provider name, a voice id or interview text — a printable separator would
 * let two different field splits hash identically.
 */
function speechKey(text: string): string {
  const provider = config.tts.provider;
  // Resolved through the same accessors the connectors use, never through a
  // literal. The ElevenLabs arm previously hardcoded its model id and read the
  // raw config value for the voice, so it described a request the connector had
  // stopped making: changing ELEVENLABS_MODEL_ID left the key identical, and an
  // unset ELEVENLABS_VOICE_ID hashed an empty voice while the connector
  // actually synthesized with its default. Either way a voice or model swap
  // kept serving the previous rendering under the same ETag, which looks
  // exactly like the setting silently not working.
  const { model, voice } = provider === 'openai'
    ? { model: openAiTtsModel(), voice: openAiTtsVoice() }
    : provider === 'elevenlabs'
      ? { model: elevenLabsModel(), voice: elevenLabsVoice() }
      // Providers with no connector never reach synthesis, so their key only
      // has to stay distinct from the two that do.
      : { model: '', voice: '' };
  return createHash('sha256').update(`${provider}\u0000${model}\u0000${voice}\u0000${text}`).digest('hex').slice(0, 32);
}

// Every synthesis is billed, and an interview replays the same handful of
// questions (reconnects, re-listens, a candidate hitting "repeat that"). A tiny
// in-process LRU turns those into free hits. Bounded on both entry count and
// bytes so it cannot become a memory leak driven by attacker-chosen input; it
// is intentionally per-process and lost on restart, since correctness never
// depends on it.
const SPEECH_CACHE_MAX_ENTRIES = 64;
const SPEECH_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const speechCache = new Map<string, SynthesizedSpeech>();
let speechCacheBytes = 0;

function cacheGet(key: string): SynthesizedSpeech | undefined {
  const hit = speechCache.get(key);
  if (!hit) return undefined;
  // Re-insert to move to the tail: Map preserves insertion order, so the head
  // is the least recently used.
  speechCache.delete(key);
  speechCache.set(key, hit);
  return hit;
}

function cachePut(key: string, value: SynthesizedSpeech): void {
  // Subtract the outgoing entry first. Map.set replaces it silently, so without
  // this the old entry's bytes stay counted but become unreachable — the
  // counter ratchets up, never recovers, and once it passes the ceiling the
  // eviction loop empties the cache on every put. The failure mode is a
  // permanently dead cache that bills the vendor for every single request,
  // which is the exact cost this cache exists to prevent.
  const previous = speechCache.get(key);
  if (previous) speechCacheBytes -= previous.audio.byteLength;

  speechCache.set(key, value);
  speechCacheBytes += value.audio.byteLength;
  while (speechCache.size > SPEECH_CACHE_MAX_ENTRIES || speechCacheBytes > SPEECH_CACHE_MAX_BYTES) {
    const oldest = speechCache.keys().next();
    if (oldest.done) break;
    const evicted = speechCache.get(oldest.value);
    speechCache.delete(oldest.value);
    if (evicted) speechCacheBytes -= evicted.audio.byteLength;
  }
}

/** Test hook — drops all cached audio. */
export function _resetSpeechCache(): void {
  speechCache.clear();
  speechCacheBytes = 0;
  inFlight.clear();
}

/** Test/diagnostic hook — cached entry count and the tracked byte total. */
export function _speechCacheStats(): { entries: number; bytes: number } {
  return { entries: speechCache.size, bytes: speechCacheBytes };
}

// Concurrent requests for the same uncached turn would each miss the cache and
// each bill a synthesis. Candidates reconnecting, or a client firing parallel
// requests, make that a normal occurrence rather than an edge case — so
// collapse identical in-flight work onto one vendor call.
const inFlight = new Map<string, Promise<SynthesizedSpeech>>();

/**
 * Strong validator for `text` without synthesizing it. Lets a caller answer a
 * conditional request before spending anything at the vendor.
 */
export function speechEtag(text: string): string {
  return `"${speechKey(text)}"`;
}

/**
 * Synthesize via whichever server provider is configured, with caching.
 *
 * Returns null when no server provider is available so callers can signal
 * "use browser speech" instead of failing — the zero-key path is a core
 * property of this build and must never degrade into an error.
 */
export async function synthesizeServerSpeech(text: string): Promise<SynthesizedSpeech | null> {
  if (!serverTtsReady()) return null;

  const key = speechKey(text);
  const cached = cacheGet(key);
  if (cached) return cached;

  // `serverTtsReady` admits azure, which has no connector yet. Checked before
  // taking an in-flight slot so an unsupported provider cannot park a promise.
  if (config.tts.provider !== 'openai' && config.tts.provider !== 'elevenlabs') {
    logger.warn({ provider: config.tts.provider }, 'No server TTS connector for configured provider');
    return null;
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const provider = config.tts.provider;
  const work = (async (): Promise<SynthesizedSpeech> => {
    const audio = provider === 'openai' ? await synthesizeOpenAI(text) : await synthesizeElevenLabs(text);
    const result: SynthesizedSpeech = { audio, contentType: 'audio/mpeg', etag: `"${key}"` };
    cachePut(key, result);
    return result;
  })().finally(() => {
    // Always release the slot, including on failure — otherwise one vendor
    // outage would permanently wedge that key and every later request for it
    // would reject against a settled promise.
    inFlight.delete(key);
  });

  inFlight.set(key, work);
  return work;
}
