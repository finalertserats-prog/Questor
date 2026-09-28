// The observer room's capture loop.
//
// The interviewer's device hears the round (their own voice, and the candidate
// through the speakers). Every chunkMs the loop hands what it has to the
// server: recorded audio when the server transcribes, recognised text when the
// browser does. Everything it touches is injected, so the rules below are
// tested without a microphone:
//
//   - stop() without flush sends nothing more, not even the chunk in progress.
//     A stop is someone withdrawing consent; audio from that moment on is not
//     ours to keep.
//   - a refused upload (the server says the observer is no longer listening)
//     stops capture at once: the candidate may have stopped it from their link.
//   - a failed transcription is a gap, reported as such, and capture goes on.

export interface ChunkRecorder {
  /** End the current chunk and begin the next one on the same stream. */
  next(): Promise<Blob | null>;
  /** End the current chunk, return it, and release the microphone. */
  finish(): Promise<Blob | null>;
  /** Release the microphone and discard the chunk in progress. */
  close(): Promise<void>;
}

export interface RecognizerHandlers {
  onFinal: (text: string) => void;
  onSilence?: () => void;
  onDead?: (reason: string) => void;
}

export interface ObserverRecognizer {
  start(): void;
  stop(): void;
  abort(): void;
}

export type UploadOutcome = 'ok' | 'refused' | 'gap';

export type CaptureState =
  | { kind: 'listening' }
  | { kind: 'degraded'; message: string }
  | { kind: 'stopped'; reason: 'stopped' | 'refused' | 'unavailable' };

export interface CaptureDeps {
  mode: 'server' | 'browser';
  chunkMs: number;
  now(): number;
  /** Run fn after ms; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  openMicrophone(): Promise<ChunkRecorder | null>;
  createRecognizer(handlers: RecognizerHandlers): ObserverRecognizer | null;
  sendAudio(blob: Blob, offsetMs: number, durationMs: number): Promise<UploadOutcome>;
  sendText(text: string, offsetMs: number, durationMs: number): Promise<UploadOutcome>;
  reportGap(offsetMs: number, durationMs: number, reason: string): Promise<void>;
  onState(state: CaptureState): void;
}

export interface ObserverCapture {
  start(): Promise<boolean>;
  stop(o: { flush: boolean }): Promise<void>;
}

const FLUSH_TIMEOUT_MS = 5_000;
const DEGRADED_MESSAGE = 'Part of the round could not be transcribed. The observer is still listening; the transcript will show the gap.';

export function createObserverCapture(deps: CaptureDeps): ObserverCapture {
  let stopped = false;
  let flushing = false;
  let startedAt = 0;
  let chunkStart = 0;
  let cancelTimer: () => void = () => undefined;
  let mic: ChunkRecorder | null = null;
  let recognizer: ObserverRecognizer | null = null;
  let flushed: (() => void) | null = null;

  const offset = (at: number) => Math.max(0, at - startedAt);

  async function halt(reason: 'stopped' | 'refused' | 'unavailable'): Promise<void> {
    if (stopped) return;
    stopped = true;
    cancelTimer();
    recognizer?.abort();
    await mic?.close();
    deps.onState({ kind: 'stopped', reason });
  }

  async function settle(outcome: UploadOutcome): Promise<void> {
    if (outcome === 'refused') await halt('refused');
    else if (outcome === 'gap') deps.onState({ kind: 'degraded', message: DEGRADED_MESSAGE });
  }

  async function unavailable(reason: string): Promise<false> {
    await deps.reportGap(0, 0, reason).catch(() => undefined);
    await halt('unavailable');
    return false;
  }

  function scheduleTick(tick: () => Promise<void>) {
    cancelTimer = deps.schedule(() => { void tick(); }, deps.chunkMs);
  }

  // --- server transcription: rotate recorded chunks -----------------------

  async function serverTick(): Promise<void> {
    if (stopped || !mic) return;
    const from = chunkStart;
    const blob = await mic.next();
    chunkStart = deps.now();
    if (stopped) return;
    scheduleTick(serverTick);
    if (blob) await settle(await deps.sendAudio(blob, offset(from), chunkStart - from));
  }

  async function startServer(): Promise<boolean> {
    mic = await deps.openMicrophone();
    if (!mic) return unavailable('microphone-unavailable');
    scheduleTick(serverTick);
    return true;
  }

  // --- browser recognition: take what was heard each interval --------------

  function onFinal(text: string): void {
    const from = chunkStart;
    chunkStart = deps.now();
    if (stopped && !flushing) return;
    const done = flushed;
    flushed = null;
    const send = text.trim()
      ? deps.sendText(text.trim(), offset(from), chunkStart - from).then(settle)
      : Promise.resolve();
    void send.finally(() => done?.());
    if (!stopped) recognizer?.start();
  }

  function startBrowser(): boolean {
    recognizer = deps.createRecognizer({
      onFinal,
      onSilence: () => { if (!stopped) recognizer?.start(); },
      onDead: (reason) => {
        if (stopped) return;
        const now = deps.now();
        void deps.reportGap(offset(chunkStart), now - chunkStart, reason).catch(() => undefined);
        deps.onState({ kind: 'degraded', message: DEGRADED_MESSAGE });
      },
    });
    if (!recognizer) return false;
    recognizer.start();
    const tick = async () => {
      if (stopped) return;
      recognizer?.stop();
      scheduleTick(tick);
    };
    scheduleTick(tick);
    return true;
  }

  return {
    async start() {
      startedAt = deps.now();
      chunkStart = startedAt;
      const ok = deps.mode === 'server' ? await startServer() : startBrowser();
      if (!ok) return deps.mode === 'server' ? false : unavailable('speech-recognition-unavailable');
      deps.onState({ kind: 'listening' });
      return true;
    },

    async stop({ flush }) {
      if (stopped) return;
      if (!flush) { await halt('stopped'); return; }
      stopped = true;
      flushing = true;
      cancelTimer();
      if (mic) {
        const from = chunkStart;
        const blob = await mic.finish();
        const end = deps.now();
        if (blob) await deps.sendAudio(blob, offset(from), end - from).catch(() => 'gap' as const);
      } else if (recognizer) {
        // Bounded: a recogniser that never reports its last words must not
        // leave the round unable to end.
        await new Promise<void>((resolve) => {
          const cancel = deps.schedule(resolve, FLUSH_TIMEOUT_MS);
          flushed = () => { cancel(); resolve(); };
          recognizer?.stop();
        });
      }
      flushing = false;
      deps.onState({ kind: 'stopped', reason: 'stopped' });
    },
  };
}
