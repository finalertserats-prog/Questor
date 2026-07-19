import 'dotenv/config';

function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  port: parseInt(env('PORT', '4000'), 10),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
  authSecret: env('AUTH_SECRET', 'dev-questor-secret-change-me-please-32chars'),
  webhookSigningSecret: env('WEBHOOK_SIGNING_SECRET', 'dev-webhook-secret'),

  llm: {
    provider: env('LLM_PROVIDER', 'heuristic'),
    anthropicKey: env('ANTHROPIC_API_KEY'),
    anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    openaiKey: env('OPENAI_API_KEY'),
    openaiModel: env('OPENAI_MODEL', 'gpt-4o'),
  },
  stt: {
    provider: env('STT_PROVIDER', 'webspeech'),
    deepgramKey: env('DEEPGRAM_API_KEY'),
    azureKey: env('AZURE_SPEECH_KEY'),
    azureRegion: env('AZURE_SPEECH_REGION'),
  },
  tts: {
    provider: env('TTS_PROVIDER', 'webspeech'),
    elevenKey: env('ELEVENLABS_API_KEY'),
    elevenVoice: env('ELEVENLABS_VOICE_ID'),
  },
  email: {
    provider: env('EMAIL_PROVIDER', 'console'),
    from: env('EMAIL_FROM', 'Questor <no-reply@questor.local>'),
    sendgridKey: env('SENDGRID_API_KEY'),
    smtpHost: env('SMTP_HOST'),
    smtpPort: parseInt(env('SMTP_PORT', '587'), 10),
    smtpUser: env('SMTP_USER'),
    smtpPass: env('SMTP_PASS'),
  },
  ats: {
    provider: env('ATS_PROVIDER', 'generic'),
    baseUrl: env('ATS_BASE_URL'),
    apiKey: env('ATS_API_KEY'),
  },
  meeting: {
    provider: env('MEETING_PROVIDER', 'hosted'),
  },
};

export type AppConfig = typeof config;
