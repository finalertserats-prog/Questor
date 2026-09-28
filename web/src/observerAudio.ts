import type { ChunkRecorder } from './observerCapture';

// The observer room's microphone: one stream for the whole round, cut into
// self-contained chunks. A fresh MediaRecorder per chunk, because a timesliced
// WebM fragment after the first has no header and cannot be transcribed on
// its own.

interface Take {
  recorder: MediaRecorder;
  parts: Blob[];
}

function begin(stream: MediaStream): Take {
  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) parts.push(event.data); };
  recorder.start();
  return { recorder, parts };
}

function end(take: Take): Promise<Blob | null> {
  return new Promise((resolve) => {
    take.recorder.onstop = () => {
      resolve(take.parts.length ? new Blob(take.parts, { type: take.recorder.mimeType || 'audio/webm' }) : null);
    };
    try { take.recorder.stop(); } catch { resolve(null); }
  });
}

/** Null when the browser cannot record or the person refused the microphone. */
export async function openChunkedMicrophone(): Promise<ChunkRecorder | null> {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return null;
  }
  let current = begin(stream);
  const release = () => stream.getTracks().forEach((track) => track.stop());
  return {
    next: async () => {
      const previous = current;
      current = begin(stream);
      return end(previous);
    },
    finish: async () => {
      const blob = await end(current);
      release();
      return blob;
    },
    close: async () => {
      // Discard: drop the data handler first so nothing recorded is kept.
      current.recorder.ondataavailable = null;
      try { current.recorder.stop(); } catch { /* already stopped */ }
      release();
    },
  };
}
