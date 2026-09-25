import { encodeWav, levelSpeech, measureLoudness } from './voiceLevelling';

/**
 * Decode rate for levelling. The vendors return 24 kHz (OpenAI) and 44.1 kHz
 * (ElevenLabs); decoding at 44.1 kHz keeps the full band of either.
 */
export const DECODE_SAMPLE_RATE = 44_100;

/**
 * Levelling normally takes tens of milliseconds, after a synthesis that takes
 * seconds. If a slow device takes longer than this, the original clip plays:
 * a question a little uneven is better than a question late.
 */
export const LEVELLING_BUDGET_MS = 250;

interface DecodedClip {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

function toMono(clip: DecodedClip): Float32Array {
  if (clip.numberOfChannels <= 1) return clip.getChannelData(0);
  const first = clip.getChannelData(0);
  const mixed = new Float32Array(first.length);
  for (let c = 0; c < clip.numberOfChannels; c++) {
    const channel = clip.getChannelData(c);
    for (let i = 0; i < mixed.length; i++) mixed[i] += channel[i] / clip.numberOfChannels;
  }
  return mixed;
}

async function level(clip: Blob): Promise<Blob> {
  // An offline context decodes without a user gesture and without touching
  // the speakers; the room's live context is left alone.
  const ctx = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE);
  const decoded: DecodedClip = await ctx.decodeAudioData(await clip.arrayBuffer());
  const samples = toMono(decoded);
  if (measureLoudness(samples, decoded.sampleRate) === null) return clip;
  return new Blob([encodeWav(levelSpeech(samples, decoded.sampleRate), decoded.sampleRate)], { type: 'audio/wav' });
}

/**
 * The interviewer clip, levelled to the same loudness as every other turn
 * (see voiceLevelling.ts). Never fails: when the browser cannot decode, or
 * levelling would delay the question, the original clip comes back.
 */
export async function levelSpeechClip(clip: Blob, budgetMs = LEVELLING_BUDGET_MS): Promise<Blob> {
  if (typeof OfflineAudioContext === 'undefined') return clip;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Blob>((resolve) => { timer = setTimeout(() => resolve(clip), budgetMs); });
  try {
    return await Promise.race([level(clip), late]);
  } catch {
    return clip;
  } finally {
    clearTimeout(timer);
  }
}
