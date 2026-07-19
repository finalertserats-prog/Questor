import { config } from '../config.js';

// Speech provider descriptors. The default `webspeech` runs entirely in the
// candidate's browser (SpeechRecognition + speechSynthesis) — zero keys, open.
// Paid connectors advertise their capabilities and required credentials so the
// client can switch transports once a license key is present.

export interface SpeechCapability {
  provider: string;
  mode: 'browser' | 'server';
  configured: boolean;
  streaming: boolean;
  languages: string[];
  notes: string;
}

export function sttCapability(): SpeechCapability {
  switch (config.stt.provider) {
    case 'deepgram':
      return { provider: 'deepgram', mode: 'server', configured: !!config.stt.deepgramKey, streaming: true, languages: ['en', 'multi'], notes: 'Deepgram streaming ASR. Set DEEPGRAM_API_KEY.' };
    case 'whisper':
      return { provider: 'whisper', mode: 'server', configured: !!config.llm.openaiKey, streaming: false, languages: ['multi'], notes: 'OpenAI Whisper batch transcription.' };
    case 'azure':
      return { provider: 'azure', mode: 'server', configured: !!config.stt.azureKey, streaming: true, languages: ['multi'], notes: 'Azure Speech. Set AZURE_SPEECH_KEY + region.' };
    default:
      return { provider: 'webspeech', mode: 'browser', configured: true, streaming: true, languages: ['en'], notes: 'Browser-native SpeechRecognition. No key required.' };
  }
}

export function ttsCapability(): SpeechCapability {
  switch (config.tts.provider) {
    case 'elevenlabs':
      return { provider: 'elevenlabs', mode: 'server', configured: !!config.tts.elevenKey, streaming: true, languages: ['multi'], notes: 'ElevenLabs neural voices. Set ELEVENLABS_API_KEY.' };
    case 'openai':
      return { provider: 'openai', mode: 'server', configured: !!config.llm.openaiKey, streaming: true, languages: ['multi'], notes: 'OpenAI TTS voices.' };
    case 'azure':
      return { provider: 'azure', mode: 'server', configured: !!config.stt.azureKey, streaming: true, languages: ['multi'], notes: 'Azure neural TTS.' };
    default:
      return { provider: 'webspeech', mode: 'browser', configured: true, streaming: true, languages: ['en'], notes: 'Browser-native speechSynthesis. No key required.' };
  }
}

/**
 * Server-side ElevenLabs TTS connector (returns audio bytes). Only used when
 * TTS_PROVIDER=elevenlabs and a key is present; the browser falls back to
 * speechSynthesis otherwise.
 */
export async function synthesizeElevenLabs(text: string): Promise<Buffer> {
  if (!config.tts.elevenKey) throw new Error('ElevenLabs not configured');
  const voice = config.tts.elevenVoice || '21m00Tcm4TlvDq8ikWAM';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: { 'xi-api-key': config.tts.elevenKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_turbo_v2' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
