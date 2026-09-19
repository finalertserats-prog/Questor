import { onSpeechActivity, type SpeechActivity } from '../../speech';
import { rmsLevel, spokenWords, voiceTarget, type VoiceState } from './roomLevelModel';

/**
 * Follows the interviewer's voice so the room can animate it and reveal its
 * words as they are said.
 *
 * Server audio is measured with a Web Audio analyser. That needs an
 * AudioContext, which browsers only let run after a user gesture — so it is
 * created by `prime()`, called from the Join click, and never before. If the
 * context is not running, the audio is left alone: routing an element through
 * a suspended context would silence the interviewer, which is far worse than
 * a ring that is estimated from the text.
 */
export class AiVoiceLevel {
  private state: VoiceState | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private audio: HTMLAudioElement | null = null;

  /** Create the audio context inside the Join click. Safe to call more than once. */
  prime(): void {
    if (this.context || typeof AudioContext === 'undefined') return;
    try {
      this.context = new AudioContext();
      void this.context.resume().catch(() => undefined);
    } catch {
      this.context = null;
    }
  }

  /** Start following speech events. Returns the unsubscribe. */
  listen(): () => void {
    onSpeechActivity((event) => this.handle(event));
    return () => {
      onSpeechActivity(null);
      this.state = null;
      void this.context?.close().catch(() => undefined);
      this.context = null;
    };
  }

  /** Target loudness for this frame, 0..1 (smoothing is the ring's job). */
  level(now = performance.now()): number {
    if (!this.state) return 0;
    return voiceTarget(this.withAudio(this.state), now);
  }

  /** Words of `text` spoken so far, or null when that text is not being spoken. */
  spoken(text: string, now = performance.now()): number | null {
    if (!this.state || this.state.text !== text) return null;
    return spokenWords(this.withAudio(this.state), now);
  }

  private withAudio(state: VoiceState): VoiceState {
    const audio = this.audio;
    const fraction = audio && Number.isFinite(audio.duration) && audio.duration > 0
      ? Math.min(1, audio.currentTime / audio.duration)
      : null;
    let analyserLevel: number | null = null;
    if (this.analyser && this.samples) {
      this.analyser.getByteTimeDomainData(this.samples);
      analyserLevel = rmsLevel(this.samples);
    }
    return { ...state, audioFraction: fraction, analyserLevel };
  }

  private handle(event: SpeechActivity): void {
    const now = performance.now();
    if (event.type === 'end') {
      this.state = null;
      this.audio = null;
      this.analyser = null;
      return;
    }
    if (event.type === 'boundary') {
      if (this.state) this.state = { ...this.state, boundary: { charIndex: event.charIndex, at: now } };
      return;
    }
    this.audio = event.audio;
    this.analyser = event.audio ? this.attach(event.audio) : null;
    this.state = {
      text: event.text,
      startedAt: now,
      source: event.audio ? 'server' : 'browser',
      boundary: null,
      audioFraction: null,
      analyserLevel: null,
    };
  }

  private attach(audio: HTMLAudioElement): AnalyserNode | null {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return null;
    try {
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      // Through to the speakers as well: a media element routed into a context
      // plays only through that context.
      analyser.connect(ctx.destination);
      this.samples = new Uint8Array(analyser.frequencyBinCount);
      return analyser;
    } catch {
      return null;
    }
  }
}
