// Loudness levelling for the interviewer's voice.
//
// Every interviewer turn is a separately generated clip, and the room used to
// play each one exactly as the vendor returned it. Measured on the repo's own
// OpenAI clips (server/sim-results/voice/openai), whole clips differ by ~2 dB,
// and inside one clip the 400 ms loudness swings ~10 dB between p10 and p90 —
// up to ~19 dB where the "relaxed, natural pauses" delivery lets a line trail
// off. A candidate hears that as the voice going "super low at times and high
// at times" (owner, 2026-09-22).
//
// Levelling happens here, on the decoded samples, before playback. The result
// plays through the same <audio> element as before, so it is levelled on every
// path — routed through the room's audio graph or not — and nothing about
// timing, captions or the watchdog changes.
//
// Pure functions over Float32Array: no browser APIs, so all of it is tested
// directly.

/** Where every clip's gated loudness lands, in dBFS. Close to the level the vendor clips already sat at (~-21.6), so candidates' volume settings stay right. */
export const TARGET_LOUDNESS_DB = -20;
/** A near-silent clip is noise, not a quiet voice: it is never raised further than this. */
export const MAX_CLIP_BOOST_DB = 12;
/** Nor is a hot clip ever cut further than this. */
export const MAX_CLIP_CUT_DB = 12;
/** Sample peak ceiling after levelling (-1 dBFS), so a boost can never clip. */
export const PEAK_CEILING = 10 ** (-1 / 20);

// Loudness is read in 400 ms blocks every 100 ms — the momentary window of
// ITU-R BS.1770 — which follows phrases rather than individual syllables.
const BLOCK_SECONDS = 0.4;
const HOP_SECONDS = 0.1;
// Blocks quieter than this are silence and do not count towards loudness.
const ABSOLUTE_GATE_DB = -50;
// Nor do blocks this far under the ungated level (BS.1770's relative gate):
// breaths and room tone would otherwise drag the reading down.
const RELATIVE_GATE_DB = 10;
// Within a clip, deviations from the clip's own level are halved, and never
// corrected by more than this. Halving evens a trailing-off line without
// flattening the natural rise and fall of speech.
const LEVELLING_RATIO = 0.5;
const MAX_PHRASE_CORRECTION_DB = 6;
// A block this far under the clip's level is a pause, not a quiet word: the
// correction is held there rather than turning the pause up.
const PAUSE_BELOW_CLIP_DB = 20;
// How quickly the phrase correction may move. Slow enough not to pump.
const CORRECTION_SMOOTHING_SECONDS = 0.2;
// The final trim that lands the levelled clip on the target is small by
// construction; this bound only stops it undoing the boost cap.
const MAX_TRIM_DB = 3;
// Peak limiter: looks this far ahead so the gain is already down when a peak
// arrives, then recovers over the release.
const LIMITER_LOOKAHEAD_SECONDS = 0.005;
const LIMITER_RELEASE_SECONDS = 0.08;

const dbToGain = (db: number) => 10 ** (db / 20);
const powerToDb = (p: number) => 10 * Math.log10(p);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Blocks {
  /** Mean-square power of each block. */
  readonly power: Float64Array;
  /** Sample index of each block's centre. */
  readonly centre: Float64Array;
}

function blockPowers(samples: Float32Array, sampleRate: number): Blocks {
  const n = samples.length;
  const size = Math.max(1, Math.min(n, Math.round(BLOCK_SECONDS * sampleRate)));
  const hop = Math.max(1, Math.round(HOP_SECONDS * sampleRate));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + samples[i] * samples[i];
  const count = n === 0 ? 0 : Math.floor((n - size) / hop) + 1;
  const power = new Float64Array(count);
  const centre = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const start = k * hop;
    power[k] = (prefix[start + size] - prefix[start]) / size;
    centre[k] = start + size / 2;
  }
  return { power, centre };
}

function gatedLoudness(power: Float64Array): number | null {
  const gate = dbToGain(ABSOLUTE_GATE_DB) ** 2;
  let sum = 0;
  let count = 0;
  for (const p of power) if (p > gate) { sum += p; count += 1; }
  if (count === 0) return null;
  const relative = (sum / count) * dbToGain(-RELATIVE_GATE_DB) ** 2;
  let gatedSum = 0;
  let gatedCount = 0;
  for (const p of power) if (p > gate && p > relative) { gatedSum += p; gatedCount += 1; }
  return powerToDb(gatedSum / gatedCount);
}

/**
 * Gated loudness of a clip in dBFS (unweighted BS.1770-style blocks and
 * gates), or null when it is silent.
 */
export function measureLoudness(samples: Float32Array, sampleRate: number): number | null {
  return gatedLoudness(blockPowers(samples, sampleRate).power);
}

/** Per-block phrase correction in dB: deviations halved, pauses held, smoothed both ways so it anticipates as well as follows. */
function phraseCorrections(power: Float64Array, clipDb: number, hopSeconds: number): Float64Array {
  const out = new Float64Array(power.length);
  let held = 0;
  for (let k = 0; k < power.length; k++) {
    const blockDb = power[k] > 0 ? powerToDb(power[k]) : -Infinity;
    if (blockDb > clipDb - PAUSE_BELOW_CLIP_DB) {
      held = clamp((clipDb - blockDb) * LEVELLING_RATIO, -MAX_PHRASE_CORRECTION_DB, MAX_PHRASE_CORRECTION_DB);
    }
    out[k] = held;
  }
  const alpha = 1 - Math.exp(-hopSeconds / CORRECTION_SMOOTHING_SECONDS);
  for (let k = 1; k < out.length; k++) out[k] = out[k - 1] + alpha * (out[k] - out[k - 1]);
  for (let k = out.length - 2; k >= 0; k--) out[k] = out[k + 1] + alpha * (out[k] - out[k + 1]);
  return out;
}

/** Apply per-block dB corrections, linearly interpolated between block centres. */
function applyCorrections(samples: Float32Array, blocks: Blocks, correctionDb: Float64Array, baseDb: number): Float32Array {
  const out = new Float32Array(samples.length);
  const { centre } = blocks;
  let k = 0;
  for (let i = 0; i < samples.length; i++) {
    while (k < centre.length - 1 && centre[k + 1] <= i) k += 1;
    let db = correctionDb[k];
    if (k < centre.length - 1 && i > centre[k]) {
      const t = (i - centre[k]) / (centre[k + 1] - centre[k]);
      db = correctionDb[k] + t * (correctionDb[k + 1] - correctionDb[k]);
    }
    out[i] = samples[i] * dbToGain(baseDb + db);
  }
  return out;
}

/**
 * Look-ahead peak limiter. The gain at every sample is at most what that
 * sample, and every peak in the next few milliseconds, needs to stay under the
 * ceiling — so nothing clips — and recovers smoothly afterwards.
 */
function limitPeaks(samples: Float32Array, sampleRate: number): Float32Array {
  const n = samples.length;
  const look = Math.max(1, Math.round(LIMITER_LOOKAHEAD_SECONDS * sampleRate));
  const needed = new Float32Array(n);
  let anyOver = false;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    needed[i] = a > PEAK_CEILING ? PEAK_CEILING / a : 1;
    if (needed[i] < 1) anyOver = true;
  }
  if (!anyOver) return samples;

  // Minimum of `needed` over [i, i + look], by a monotonic queue.
  const ahead = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let j = n - 1; j >= 0; j--) {
    while (tail > head && needed[queue[tail - 1]] >= needed[j]) tail -= 1;
    queue[tail++] = j;
    while (queue[head] > j + look) head += 1;
    ahead[j] = needed[queue[head]];
  }
  // Averaging over the previous `look` samples turns the step into a ramp
  // that is still never above what any sample in the window needs.
  const release = 1 - Math.exp(-1 / (LIMITER_RELEASE_SECONDS * sampleRate));
  const out = new Float32Array(n);
  let windowSum = 0;
  let gain = 1;
  for (let i = 0; i < n; i++) {
    windowSum += ahead[i];
    if (i >= look) windowSum -= ahead[i - look];
    const ramp = windowSum / Math.min(i + 1, look);
    gain = Math.min(ramp, gain + release * (1 - gain));
    // The bound above makes this clamp a no-op in exact arithmetic; it is kept
    // so float rounding can never produce a clipped sample.
    out[i] = clamp(samples[i] * gain, -PEAK_CEILING, PEAK_CEILING);
  }
  return out;
}

/**
 * Level one clip: bring it to the target loudness, even out phrases within
 * it, and limit peaks. Returns a new array; the input is not modified. A
 * silent clip comes back as an unchanged copy.
 */
export function levelSpeech(samples: Float32Array, sampleRate: number): Float32Array {
  const blocks = blockPowers(samples, sampleRate);
  const clipDb = gatedLoudness(blocks.power);
  if (clipDb === null) return samples.slice();

  const clipGainDb = clamp(TARGET_LOUDNESS_DB - clipDb, -MAX_CLIP_CUT_DB, MAX_CLIP_BOOST_DB);
  const corrections = phraseCorrections(blocks.power, clipDb, HOP_SECONDS);
  const shaped = applyCorrections(samples, blocks, corrections, clipGainDb);

  // Phrase corrections move the overall level a little; trim it back onto the
  // target, within the clip's boost and cut caps.
  const shapedDb = measureLoudness(shaped, sampleRate) ?? TARGET_LOUDNESS_DB;
  const trimDb = clamp(
    TARGET_LOUDNESS_DB - shapedDb,
    Math.max(-MAX_TRIM_DB, -MAX_CLIP_CUT_DB - clipGainDb),
    Math.min(MAX_TRIM_DB, MAX_CLIP_BOOST_DB - clipGainDb),
  );
  const trim = dbToGain(trimDb);
  const trimmed = shaped.map((v) => v * trim);
  return limitPeaks(trimmed, sampleRate);
}

/** 16-bit mono PCM WAV of the samples, for playback through an <audio> element. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = clamp(samples[i], -1, 1);
    view.setInt16(44 + i * 2, v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), true);
  }
  return bytes;
}
