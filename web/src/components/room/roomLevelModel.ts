/**
 * How loud each participant "looks", and how far through its words the
 * interviewer has got.
 *
 * The speaking ring is not decoration: it is how a candidate knows, without
 * reading anything, whose turn it is and that their microphone is working. So
 * it is driven by a real signal wherever one exists — the candidate's mic, the
 * server voice through an analyser, the browser voice's word boundaries — and
 * only estimated from the text when the browser gives us nothing better.
 */

/** Fast attack so speech onset shows at once; slow release so it doesn't flicker between words. */
const ATTACK = 0.35;
const RELEASE = 0.12;
const SILENT = 0.001;

export function smoothLevel(current: number, target: number): number {
  const goal = Math.min(1, Math.max(0, target));
  const next = current + (goal - current) * (goal > current ? ATTACK : RELEASE);
  return next < SILENT ? 0 : Math.min(1, next);
}

// Hysteresis: "Speaking" switches on at a clear voice and off only at near
// silence, so the status does not flicker on every breath between words.
const SPEAKING_ON = 0.12;
const SPEAKING_OFF = 0.05;

export function isSpeakingNow(wasSpeaking: boolean, level: number): boolean {
  return wasSpeaking ? level >= SPEAKING_OFF : level >= SPEAKING_ON;
}

/** The room accent, for a colour the canvas could not read from the stylesheet. */
const FALLBACK_RGB: readonly [number, number, number] = [165, 160, 245];

function parseRgb(color: string): readonly [number, number, number] {
  const rgb = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = color.trim().match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  return FALLBACK_RGB;
}

/**
 * A canvas colour at some opacity. The ring's colour comes from the
 * stylesheet's tokens (read as a computed colour), so the tokens stay the one
 * place a room colour is defined.
 */
export function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = parseRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

const PHRASE_END = /[.,?!;:]$/;

/**
 * A speech envelope from the words themselves: louder on long words, dipping
 * where a phrase ends, so the ring reads as talking rather than as a pulse.
 */
export function wordEnvelope(word: string): number {
  if (PHRASE_END.test(word)) return 0.25;
  return Math.min(1, 0.5 + word.length / 14);
}

function wordStarts(text: string): number[] {
  return [...text.matchAll(/\S+/g)].map((m) => m.index ?? 0);
}

/** Words spoken once the voice has reached `charIndex` (the word it is on counts). */
export function wordsSpokenAtChar(text: string, charIndex: number): number {
  return wordStarts(text).filter((start) => start <= charIndex).length;
}

/** Roughly the pace of the room's voices at rate 1.02. */
const MS_PER_WORD = 380;
const SENTENCE_PAUSE_MS = 260;
const COMMA_PAUSE_MS = 120;

function wordDuration(word: string): number {
  if (/[.?!]$/.test(word)) return MS_PER_WORD + SENTENCE_PAUSE_MS;
  if (/[,;:]$/.test(word)) return MS_PER_WORD + COMMA_PAUSE_MS;
  return MS_PER_WORD;
}

/** Words started after `elapsedMs` of speech, for voices that report no progress at all. */
export function estimatedWordsSpoken(text: string, elapsedMs: number): number {
  const words = splitWords(text);
  let startsAt = 0;
  let spoken = 0;
  for (const word of words) {
    if (startsAt > elapsedMs) break;
    spoken += 1;
    startsAt += wordDuration(word);
  }
  return spoken;
}

/** Words reached at a playback fraction, weighting each word by its length. */
export function wordsSpokenAtFraction(text: string, fraction: number): number {
  const words = splitWords(text);
  const total = words.reduce((sum, w) => sum + w.length, 0);
  if (!total) return 0;
  let before = 0;
  let spoken = 0;
  for (const word of words) {
    if (before / total >= fraction) break;
    spoken += 1;
    before += word.length;
  }
  return fraction >= 1 ? words.length : spoken;
}

/** RMS around the 128 midpoint of byte time-domain data, scaled to roughly 0..1 for speech. */
export function rmsLevel(samples: Uint8Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const v of samples) {
    const d = (v - 128) / 128;
    sum += d * d;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/** What is known about the interviewer's voice right now. */
export interface VoiceState {
  readonly text: string;
  readonly startedAt: number;
  readonly source: 'browser' | 'server';
  /** The browser voice's latest word boundary, when it sends them (many voices do not). */
  readonly boundary: { readonly charIndex: number; readonly at: number } | null;
  /** Server audio playback position, 0..1, once its duration is known. */
  readonly audioFraction: number | null;
  /** Measured loudness of the server audio, when an analyser could be attached. */
  readonly analyserLevel: number | null;
}

/** A boundary older than this means the voice is between phrases. */
const BOUNDARY_FRESH_MS = 350;
const MURMUR = 0.15;

export function voiceTarget(state: VoiceState | null, now: number): number {
  if (!state) return 0;
  if (state.analyserLevel !== null) return state.analyserLevel;
  const words = splitWords(state.text);
  if (state.boundary) {
    if (now - state.boundary.at > BOUNDARY_FRESH_MS) return MURMUR;
    const index = wordsSpokenAtChar(state.text, state.boundary.charIndex) - 1;
    return words[index] ? wordEnvelope(words[index]) : MURMUR;
  }
  const count = spokenWords(state, now) ?? 0;
  return words[count - 1] ? wordEnvelope(words[count - 1]) : MURMUR;
}

/** How many of the words have been spoken, or null when nothing is being spoken. */
export function spokenWords(state: VoiceState | null, now: number): number | null {
  if (!state) return null;
  if (state.boundary) return wordsSpokenAtChar(state.text, state.boundary.charIndex);
  if (state.audioFraction !== null) return wordsSpokenAtFraction(state.text, state.audioFraction);
  return estimatedWordsSpoken(state.text, now - state.startedAt);
}
