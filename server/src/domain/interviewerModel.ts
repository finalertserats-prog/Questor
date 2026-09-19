/**
 * The AI interviewers, as pure data and pure functions.
 *
 * INTERVIEWER NAME + ASSIGNED VOICE + EXISTING INTERVIEW SETTINGS = THE
 * INTERVIEW EXPERIENCE. The five interviewers differ in name and voice and in
 * nothing else: no tone, personality, questioning style, difficulty or scoring
 * hangs off them, and nothing here may grow one. Tone is a separate setting on
 * the interview (persona.tone) and is chosen independently.
 */

export interface InterviewerSeed {
  readonly id: string;
  readonly name: string;
  readonly voiceProfileId: string;
  readonly sortOrder: number;
}

export interface VoiceProfileSeed {
  readonly id: string;
  readonly displayName: string;
  readonly language: string;
  readonly locale: string;
  /**
   * Only steers which BROWSER voice speaks when there is no server voice:
   * `<female|male>:<n>` picks the n-th matching system voice. It is not a
   * provider voice id and is safe to send to the candidate's browser.
   */
  readonly fallbackHint: string;
}

export const INTERVIEWER_CATALOGUE: readonly InterviewerSeed[] = [
  { id: 'avery', name: 'Avery', voiceProfileId: 'voice_01', sortOrder: 1 },
  { id: 'maya', name: 'Maya', voiceProfileId: 'voice_02', sortOrder: 2 },
  { id: 'adrian', name: 'Adrian', voiceProfileId: 'voice_03', sortOrder: 3 },
  { id: 'elena', name: 'Elena', voiceProfileId: 'voice_04', sortOrder: 4 },
  { id: 'theo', name: 'Theo', voiceProfileId: 'voice_05', sortOrder: 5 },
];

export const VOICE_PROFILE_CATALOGUE: readonly VoiceProfileSeed[] = [
  { id: 'voice_01', displayName: 'Avery Voice', language: 'English', locale: 'en-US', fallbackHint: 'female:2' },
  { id: 'voice_02', displayName: 'Maya Voice', language: 'English', locale: 'en-US', fallbackHint: 'female:0' },
  { id: 'voice_03', displayName: 'Adrian Voice', language: 'English', locale: 'en-US', fallbackHint: 'male:0' },
  { id: 'voice_04', displayName: 'Elena Voice', language: 'English', locale: 'en-US', fallbackHint: 'female:1' },
  { id: 'voice_05', displayName: 'Theo Voice', language: 'English', locale: 'en-US', fallbackHint: 'male:1' },
];

/**
 * Default provider voices, per voice profile.
 *
 * OpenAI: all five are built-in voices of gpt-4o-mini-tts (the model
 * providers/speech.ts uses), per https://developers.openai.com/api/docs/guides/text-to-speech
 * ("Voice options": alloy, ash, ballad, coral, echo, fable, nova, onyx, sage,
 * shimmer, verse, marin, cedar; "for best quality, marin or cedar"). The two
 * best-quality voices go to Maya and Adrian; Elena (coral) and Theo (ash) are
 * clearly different timbres from them, so neither pair sounds alike; Avery
 * takes sage. Each interviewer has exactly one voice and no two share one.
 *
 * Other providers have no default here: their voice ids are account-specific,
 * so they come from VOICE_PROFILE_0N, and until then the provider's own
 * configured voice (OPENAI_TTS_VOICE / ELEVENLABS_VOICE_ID) is the fallback.
 */
const DEFAULT_PROVIDER_VOICES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  openai: { voice_01: 'sage', voice_02: 'marin', voice_03: 'cedar', voice_04: 'coral', voice_05: 'ash' },
};

export function defaultVoiceFor(profileId: string, provider: string): string {
  return DEFAULT_PROVIDER_VOICES[provider]?.[profileId] ?? '';
}

/** Providers a voice profile may name. Only openai and elevenlabs have connectors; the rest fall back. */
export const VOICE_PROVIDERS = ['openai', 'elevenlabs', 'azure', 'webspeech'] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export interface VoiceOverride {
  readonly provider: VoiceProvider;
  readonly voiceId: string;
}

// A voice id ends up in a vendor URL path (ElevenLabs), so it is held to a
// plain token: no slashes, dots or query characters can ride along in it.
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isVoiceProvider(value: string): value is VoiceProvider {
  return (VOICE_PROVIDERS as readonly string[]).includes(value);
}

/** `provider:voiceId`, e.g. `openai:marin`, or null when malformed. */
export function parseVoiceOverride(raw: string): VoiceOverride | null {
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const provider = raw.slice(0, separator).trim().toLowerCase();
  const voiceId = raw.slice(separator + 1).trim();
  if (!isVoiceProvider(provider) || !VOICE_ID_PATTERN.test(voiceId)) return null;
  return { provider, voiceId };
}

export interface ProfileOverride extends VoiceOverride {
  readonly profileId: string;
}

/**
 * VOICE_PROFILE_01..05 from an environment. Malformed values are reported by
 * variable name only, so a log line never echoes whatever was pasted there.
 */
export function voiceOverridesFromEnv(env: Readonly<Record<string, string | undefined>>): { overrides: ProfileOverride[]; invalid: string[] } {
  const overrides: ProfileOverride[] = [];
  const invalid: string[] = [];
  for (const profile of VOICE_PROFILE_CATALOGUE) {
    const variable = `VOICE_PROFILE_${profile.id.slice('voice_'.length)}`;
    const raw = env[variable];
    if (!raw || !raw.trim()) continue;
    const parsed = parseVoiceOverride(raw);
    if (parsed) overrides.push({ profileId: profile.id, ...parsed });
    else invalid.push(variable);
  }
  return { overrides, invalid };
}

/**
 * The standard disclosure that follows the introduction when the tenant has
 * not written its own. Says what actually happens: capture, transcription,
 * retention, human review, and that the candidate may ask for a repeat or a
 * pause.
 */
export const DEFAULT_DISCLOSURE_BODY =
  "Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it. I'll ask about your relevant experience. You can ask me to repeat anything or request a pause at any time.";

/**
 * The first lines of the disclosure on the consent screen: who the interviewer
 * is, that it is an AI, and that a person reviews the interview. This is where
 * the candidate is told — before the interview, in writing, with the consent
 * record keeping exactly what was shown — so the spoken opening can greet
 * them like a real interviewer would (engines/openingModel.ts).
 */
export function consentIntro(name: string | null | undefined): string {
  const who = typeof name === 'string' && name.trim() ? `${name.trim()}, an AI interviewer` : 'an AI interviewer';
  return `Your interviewer today is ${who} from Questor. A person on the hiring team reviews the interview.`;
}

// Any introduction a stored disclosure may already start with: the current
// consent one, the short-lived spoken "Hi, I'm <name>, your AI interviewer
// from Questor. I'll be conducting…", and the older "Hello, I'm <name>, an AI
// interviewer for this first-round conversation." that tenant policies carry.
const LEADING_CONSENT_INTRO = /^\s*Your interviewer today is [^.]{0,120}?\bAI interviewer\b[^.]*\.\s*(?:A person on the hiring team reviews the interview\.\s*)?/i;
const LEADING_SPOKEN_INTRO = /^\s*(?:Hello|Hi)(?:, and thank you for joining)?[,.!]?\s+I['’]m\s+[^.]{0,120}?\bAI interviewer\b[^.]*\.\s*/i;
const LEADING_CONDUCTING = /^\s*I['’]ll be conducting your first-round interview today\.\s*/i;

/**
 * The disclosure the consent screen shows: the named introduction followed by
 * the disclosure, whole. An introduction already at its start is replaced
 * rather than repeated, so the name shown is always the session's interviewer
 * and nothing after it is lost.
 */
export function composeDisclosure(name: string | null | undefined, disclosureText: string): string {
  const rest = disclosureText
    .replace(LEADING_CONSENT_INTRO, '')
    .replace(LEADING_SPOKEN_INTRO, '')
    .replace(LEADING_CONDUCTING, '')
    .trim();
  const intro = consentIntro(name);
  return rest ? `${intro} ${rest}` : intro;
}

/**
 * One entry, uniformly at random. `randomInt(max)` returns an integer in
 * [0, max) — crypto.randomInt in production, a fixed function in tests.
 */
export function pickInterviewer<T>(active: readonly T[], randomInt: (max: number) => number): T {
  if (active.length === 0) throw new Error('No active AI interviewer to choose from');
  return active[randomInt(active.length)];
}

/** True for a stored persona that predates the interviewer catalogue. */
export function needsInterviewerBackfill(persona: unknown): boolean {
  if (typeof persona !== 'object' || persona === null) return true;
  const id = (persona as { interviewerId?: unknown }).interviewerId;
  return typeof id !== 'string' || id.length === 0;
}
