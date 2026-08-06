// Browser-native speech (open-source, no keys). Speech synthesis for the agent
// voice, SpeechRecognition for the candidate. When a paid STT/TTS connector is
// configured server-side, this module is where a streaming transport would be
// swapped in; the default path needs zero credentials.

/* eslint-disable @typescript-eslint/no-explicit-any */
const AnyWindow = window as any;

export function ttsSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
export function sttSupported(): boolean {
  return typeof window !== 'undefined' && (!!AnyWindow.SpeechRecognition || !!AnyWindow.webkitSpeechRecognition);
}

let cachedVoice: SpeechSynthesisVoice | null = null;
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  cachedVoice =
    voices.find((v) => /en-(US|GB|IN)/i.test(v.lang) && /female|samantha|google|zira|aria/i.test(v.name)) ||
    voices.find((v) => /en/i.test(v.lang)) ||
    voices[0];
  return cachedVoice;
}

export function speak(text: string, onDone?: () => void): void {
  if (!ttsSupported()) { onDone?.(); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.02;
  u.pitch = 1.0;
  let fired = false;
  const finish = () => { if (fired) return; fired = true; onDone?.(); };
  u.onend = finish;
  u.onerror = finish;
  // Watchdog: some browsers never fire onend when synthesis silently fails.
  // Estimate a max duration (~2.5 words/sec) and proceed regardless.
  const words = text.split(/\s+/).length;
  const maxMs = Math.min(60000, (words / 2.5) * 1000 + 4000);
  setTimeout(finish, maxMs);
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (ttsSupported()) window.speechSynthesis.cancel();
}

export interface Recognizer {
  start(): void;
  stop(): void;
  abort(): void;
  /** Everything heard so far, finalised or not. */
  text(): string;
}

/**
 * How long the candidate may be silent before we stop restarting the recognizer
 * and ask whether they are still there.
 *
 * This deliberately does NOT submit the answer. An earlier version did, on the
 * reasoning that a long silence means they finished — but that is the same bug
 * it was meant to fix, just delayed: a candidate reading notes or thinking for
 * a minute had a half-formed answer sent and the interview moved on. Silence is
 * not consent to submit. Only the candidate ends their turn.
 */
const SILENCE_PROMPT_MS = 60000;

/** Stop an unbounded restart loop when the microphone is dead rather than quiet. */
const MAX_CONSECUTIVE_RESTARTS = 20;

export function createRecognizer(handlers: {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onEnd?: () => void;
  onError?: (e: string) => void;
  /** The candidate has gone quiet for a long time but the turn stays open. */
  onSilence?: () => void;
  /** Capture has stopped and cannot be recovered; the turn is still open. */
  onDead?: (reason: string) => void;
}): Recognizer | null {
  if (!sttSupported()) return null;
  const Ctor = AnyWindow.SpeechRecognition || AnyWindow.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;

  // Text confirmed across ALL recognition sessions for this turn. A restarted
  // session numbers its results from zero and knows nothing of the previous
  // one, so anything already heard has to be banked here before restarting or
  // it is either lost or re-counted.
  let committed = '';
  // The current session's finalised text.
  let finalBuf = '';
  // Interim text is kept because it is frequently the ONLY text there is.
  // Chrome may hold a whole sentence as interim for seconds before finalising
  // it, so a candidate who finishes speaking and immediately clicks "Done
  // answering" has an empty finalBuf. Submitting that dropped their answer and
  // made the button look broken.
  let interimBuf = '';
  // Distinguishes "the candidate said they were finished" from "Chrome ended
  // the session by itself", which are the same `onend` event but must not have
  // the same consequence.
  let finishing = false;
  let dead = false;
  let lastSpeechAt = Date.now();
  let restarts = 0;

  const join = (...parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim();
  const collected = () => join(committed, finalBuf, interimBuf);

  rec.onresult = (event: any) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalBuf += t + ' ';
      else interim += t;
    }
    interimBuf = interim;
    lastSpeechAt = Date.now();
    restarts = 0; // speech is flowing; this is a live microphone
    handlers.onInterim?.(collected());
  };

  rec.onerror = (e: any) => {
    const err = e.error ?? 'speech-error';
    // `no-speech` is Chrome reporting a quiet moment, not a fault. Letting it
    // through stopped the answer every time the candidate paused. Chrome always
    // follows it with `onend`, which restarts us.
    if (err === 'no-speech') return;
    // `aborted` is our own stop()/abort() completing — not a fault either.
    if (err === 'aborted') return;
    // Anything else means capture is genuinely broken. Do NOT close the turn:
    // the candidate still has the recorded-audio fallback and the text box, and
    // ending their answer here would submit whatever fragment happened to exist.
    dead = true;
    handlers.onError?.(err);
    handlers.onDead?.(err);
  };

  rec.onend = () => {
    // Chrome ends a `continuous` session on its own after a few seconds of
    // silence. Treating that as the end of the answer is what cut candidates
    // off mid-thought: a pause to think became a submitted answer and the
    // interviewer moved to the next question. Restart instead, banking what has
    // been heard, so pausing costs nothing.
    if (!finishing && !dead) {
      const quietFor = Date.now() - lastSpeechAt;
      if (quietFor < SILENCE_PROMPT_MS && restarts < MAX_CONSECUTIVE_RESTARTS) {
        committed = join(committed, finalBuf, interimBuf);
        finalBuf = '';
        interimBuf = '';
        restarts += 1;
        try { rec.start(); return; } catch { /* fall through */ }
      }
      // Long silence, or the recognizer will not restart. Either way the turn
      // stays OPEN — silence is not an answer. Tell the caller so it can ask.
      committed = join(committed, finalBuf, interimBuf);
      finalBuf = '';
      interimBuf = '';
      dead = restarts >= MAX_CONSECUTIVE_RESTARTS;
      if (dead) handlers.onDead?.('recognizer-unavailable');
      else handlers.onSilence?.();
      return;
    }

    const text = collected();
    committed = '';
    finalBuf = '';
    interimBuf = '';
    finishing = false;
    // Always call, even when empty: the caller has a recorded-audio fallback
    // and needs the chance to use it. Staying silent here is what made "Done
    // answering" do nothing at all.
    handlers.onFinal(text);
    handlers.onEnd?.();
  };

  return {
    start: () => {
      committed = ''; finalBuf = ''; interimBuf = '';
      finishing = false; dead = false; restarts = 0; lastSpeechAt = Date.now();
      try { rec.start(); } catch { /* already started */ }
    },
    stop: () => { finishing = true; try { rec.stop(); } catch { /* noop */ } },
    abort: () => { finishing = true; try { rec.abort(); } catch { /* noop */ } },
    text: collected,
  };
}

// Ensure voices are loaded (Chrome loads them async).
if (ttsSupported()) {
  window.speechSynthesis.onvoiceschanged = () => { cachedVoice = null; pickVoice(); };
}

// ---------------------------------------------------------------------------
// Server voice
//
// `speechSynthesis` uses whatever voices the operating system ships, which on
// Windows means SAPI — recognisably synthetic no matter how the rate and pitch
// are tuned. When a server-side neural voice is configured the interviewer
// sounds like a person instead, which matters here: a candidate who feels they
// are talking to a machine performs differently, and that difference lands in
// the transcript we then score them on.
//
// The browser voice stays as the fallback, so the zero-key path still speaks.

let currentAudio: HTMLAudioElement | null = null;

/** Speak an agent turn, preferring the server voice and falling back locally. */
export async function speakTurn(o: {
  token: string;
  turnId: string;
  text: string;
  onDone?: () => void;
}): Promise<void> {
  const finishLocally = () => speak(o.text, o.onDone);
  try {
    const res = await fetch(`/api/portal/${o.token}/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnId: o.turnId, text: o.text }),
    });
    // 204 = no server voice configured. Anything non-OK: fall back rather than
    // leave the candidate sitting in silence waiting for a question.
    if (res.status === 204 || !res.ok) { finishLocally(); return; }

    const url = URL.createObjectURL(await res.blob());
    stopSpeaking();
    const audio = new Audio(url);
    currentAudio = audio;
    let fired = false;
    const finish = () => {
      if (fired) return;
      fired = true;
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      o.onDone?.();
    };
    audio.onended = finish;
    // A failed play (autoplay policy, decode error) must not strand the
    // interview — fall through to the browser voice instead.
    audio.onerror = () => { if (!fired) { fired = true; URL.revokeObjectURL(url); finishLocally(); } };
    await audio.play().catch(() => { if (!fired) { fired = true; URL.revokeObjectURL(url); finishLocally(); } });
  } catch {
    finishLocally();
  }
}

export function stopAllSpeech(): void {
  stopSpeaking();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

// ---------------------------------------------------------------------------
// Recording + server transcription
//
// The browser's SpeechRecognition is not local: Chrome and Edge stream the
// candidate's audio to Google's speech backend. When that is unreachable —
// corporate network, firewall, an Edge quirk — recognition fails with
// `network` and voice input dies entirely, which is exactly what happened on a
// real run. It is also an uninstructed transfer of candidate audio to a third
// party the employer never chose.
//
// Recording locally and transcribing on our own server removes both problems.
// Browser recognition stays as the fallback for the zero-key build.

export interface Recording { stop(): Promise<Blob | null> }

/** Start capturing microphone audio. Returns null if unsupported or denied. */
export async function startRecording(): Promise<Recording | null> {
  if (typeof MediaRecorder === 'undefined') return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Let the browser choose its own container: Chrome/Edge produce webm/opus,
    // Safari mp4. Forcing one would fail on whichever browser lacks it, and the
    // server accepts any of them.
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    return {
      stop: () => new Promise<Blob | null>((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(chunks.length ? new Blob(chunks, { type: rec.mimeType || 'audio/webm' }) : null);
        };
        try { rec.stop(); } catch { resolve(null); }
      }),
    };
  } catch {
    return null;
  }
}

/**
 * Transcribe recorded audio on the server. Returns null when the server has no
 * STT configured (204) or the call fails, so the caller can fall back rather
 * than losing the candidate's answer.
 */
export async function transcribeOnServer(token: string, audio: Blob): Promise<string | null> {
  try {
    const form = new FormData();
    form.append('audio', audio, 'answer.webm');
    const res = await fetch(`/api/portal/${token}/transcribe`, { method: 'POST', body: form });
    if (res.status === 204 || !res.ok) return null;
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Microphone level
//
// Drives the candidate's tile so it reacts to their actual voice. This is not
// decoration: without it there is no feedback that the mic is live, and the
// commonest failure in a voice interview is a candidate talking to a muted
// input and only discovering it at the end.

export interface MicMeter { level(): number; stop(): void }

export async function createMicMeter(): Promise<MicMeter | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    return {
      level() {
        analyser.getByteTimeDomainData(buf);
        // RMS around the 128 midpoint, scaled to roughly 0..1 for speech.
        let sum = 0;
        for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
        return Math.min(1, Math.sqrt(sum / buf.length) * 4);
      },
      stop() {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      },
    };
  } catch {
    return null; // Permission denied or no device: the tile just stays static.
  }
}

/**
 * Speak a check-in when the candidate has gone quiet.
 *
 * The words come from the server so this cannot be used to synthesize arbitrary
 * text at the operator's expense — the client only chooses which of a fixed set
 * to use. The text comes back in a header so it can be captioned and, when
 * there is no server voice, spoken locally in the fallback voice.
 *
 * Resolves when the audio has finished, so the caller knows when it is safe to
 * listen again without recording the interviewer talking over the candidate.
 */
export async function speakNudge(token: string, index: number): Promise<string> {
  let text = '';
  try {
    const res = await fetch(`/api/portal/${token}/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    const header = res.headers.get('X-Nudge-Text');
    if (header) text = decodeURIComponent(header);

    if (res.status === 204 || !res.ok) {
      if (text) await new Promise<void>((done) => speak(text, done));
      return text;
    }

    const url = URL.createObjectURL(await res.blob());
    stopSpeaking();
    const audio = new Audio(url);
    currentAudio = audio;
    await new Promise<void>((done) => {
      let fired = false;
      const finish = () => { if (fired) return; fired = true; URL.revokeObjectURL(url); done(); };
      audio.onended = finish;
      audio.onerror = finish;
      void audio.play().catch(finish);
    });
    return text;
  } catch {
    // A failed check-in must never end the turn. Silence is recoverable; a
    // dropped answer is not.
    if (text) await new Promise<void>((done) => speak(text, done));
    return text;
  }
}
