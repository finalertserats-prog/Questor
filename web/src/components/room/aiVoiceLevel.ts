import { onSpeechActivity, type SpeechActivity } from '../../speech';
import { rmsLevel, spokenWords, voiceTarget, type VoiceState } from './roomLevelModel';

/**
 * Follows the interviewer's voice so the room can animate it and reveal its
 * words as they are said.
 *
 * Server audio is measured with a Web Audio analyser. That needs an
 * AudioContext, which browsers only let run after a user gesture — so it is
 * created by `prime()`, called from the Join click, and never before.
 *
 * Routing a media element through the context makes the context its only way
 * to the speakers, for good. So audio is routed only while the context is
 * running, and once it has been suspended or interrupted (a phone call, iOS
 * backgrounding the tab) routing stops for the rest of the interview: the
 * next utterance plays as a plain <audio> element, and the ring is estimated
 * from the text. A silent interviewer is far worse than an estimated ring.
 */
export class AiVoiceLevel {
  private state: VoiceState | null = null;
  private utteranceId = 0;
  /** The text of the last utterance that actually STARTED making sound. */
  private startedText: string | null = null;
  private context: AudioContext | null = null;
  private routingBroken = false;
  private source: MediaElementAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private audio: HTMLAudioElement | null = null;

  /** Create the audio context inside the Join click. Safe to call more than once. */
  prime(): void {
    if (this.context || typeof AudioContext === 'undefined') return;
    try {
      const ctx = new AudioContext();
      ctx.onstatechange = () => {
        if (ctx.state === 'running') return;
        this.routingBroken = true;
        void ctx.resume().catch(() => undefined);
      };
      void ctx.resume().catch(() => undefined);
      this.context = ctx;
    } catch {
      this.context = null;
    }
  }

  /** Start following speech events. Returns the unsubscribe. */
  listen(): () => void {
    onSpeechActivity((event) => this.handle(event));
    return () => {
      onSpeechActivity(null);
      this.release();
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

  /**
   * Whether this text was the last thing the voice actually started saying.
   *
   * False means nothing was heard: no server voice answered and the browser
   * has none (or synthesis failed silently). The room needs to know, because a
   * turn that made no sound is the one case where its words have to be
   * announced — everything else the candidate can simply hear.
   */
  spokeAloud(text: string): boolean {
    return this.startedText === text;
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
    if (event.type === 'start') {
      this.release();
      this.utteranceId = event.id;
      // Kept past the utterance's end: the room asks once the speech is over.
      this.startedText = event.text;
      this.audio = event.audio;
      this.analyser = event.audio ? this.attach(event.audio) : null;
      this.state = {
        text: event.text,
        startedAt: performance.now(),
        source: event.audio ? 'server' : 'browser',
        boundary: null,
        audioFraction: null,
        analyserLevel: null,
      };
      return;
    }
    // A cancelled utterance's events can arrive after the next one started.
    if (event.id !== this.utteranceId) return;
    if (event.type === 'end') {
      this.release();
      this.state = null;
      return;
    }
    if (this.state) this.state = { ...this.state, boundary: { charIndex: event.charIndex, at: performance.now() } };
  }

  /** Disconnect the finished utterance's nodes, so graphs do not pile up over an interview. */
  private release(): void {
    try { this.source?.disconnect(); } catch { /* already gone */ }
    try { this.analyser?.disconnect(); } catch { /* already gone */ }
    this.source = null;
    this.analyser = null;
    this.audio = null;
  }

  private attach(audio: HTMLAudioElement): AnalyserNode | null {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running' || this.routingBroken) return null;
    try {
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      // Through to the speakers as well: a media element routed into a context
      // plays only through that context.
      analyser.connect(ctx.destination);
      this.source = source;
      this.samples = new Uint8Array(analyser.frequencyBinCount);
      return analyser;
    } catch {
      return null;
    }
  }
}
