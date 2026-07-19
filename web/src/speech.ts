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
