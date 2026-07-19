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
}

export function createRecognizer(handlers: {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onEnd?: () => void;
  onError?: (e: string) => void;
}): Recognizer | null {
  if (!sttSupported()) return null;
  const Ctor = AnyWindow.SpeechRecognition || AnyWindow.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  let finalBuf = '';
  rec.onresult = (event: any) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalBuf += t + ' ';
      else interim += t;
    }
    if (interim) handlers.onInterim?.(finalBuf + interim);
  };
  rec.onerror = (e: any) => handlers.onError?.(e.error ?? 'speech-error');
  rec.onend = () => {
    const text = finalBuf.trim();
    finalBuf = '';
    if (text) handlers.onFinal(text);
    handlers.onEnd?.();
  };
  return {
    start: () => { finalBuf = ''; try { rec.start(); } catch { /* already started */ } },
    stop: () => { try { rec.stop(); } catch { /* noop */ } },
    abort: () => { try { rec.abort(); } catch { /* noop */ } },
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
