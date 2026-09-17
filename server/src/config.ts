import 'dotenv/config';

function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

/**
 * Read a TCP port, or refuse to start.
 *
 * This was `parseInt(env('PORT', '4000'), 10)` with nothing checking the
 * result. PORT="" yields NaN and `listen(NaN)` does not fail — Node binds an
 * ephemeral port instead, so the server came up, logged that it was running,
 * and was unreachable behind the reverse proxy. A deploy that looks successful
 * and serves nobody is the worst failure mode available here, so a bad value
 * stops the process at startup, naming the variable that caused it.
 *
 * Number rather than parseInt, so "80.5" and "8080abc" are refused instead of
 * silently truncated to a port nobody configured.
 */
export function parsePortSetting(variable: string, raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `${variable} must be a whole number between 1 and 65535 (got "${raw}"). `
      + 'Fix the environment variable; the server will not start with an unusable port.',
    );
  }
  return value;
}

export type V1SignatureSetting = 'on' | 'off';

/**
 * WEBHOOK_V1_SIGNATURE: the operator's switch for the original webhook
 * signature. Unset or "on" leaves each webhook's own setting in charge; "off"
 * drops the v1 header from every delivery.
 *
 * Anything else stops the process. "false", "0" or "disabled" could each mean
 * either thing to whoever typed them, and guessing wrong either breaks every
 * receiver still on v1 or quietly keeps v1 alive after the owner retired it.
 */
export function parseV1SignatureSetting(raw: string): V1SignatureSetting {
  const value = raw.trim().toLowerCase();
  if (value === '' || value === 'on') return 'on';
  if (value === 'off') return 'off';
  throw new Error(
    `WEBHOOK_V1_SIGNATURE must be "on" or "off" (got "${raw}"). `
    + 'Leave it unset to let each webhook decide; set it to "off" once every receiver verifies the v2 signature.',
  );
}

export const config = {
  nodeEnv: env('NODE_ENV', 'development'),
  port: parsePortSetting('PORT', env('PORT', '4000')),
  /**
   * Network interface to listen on. Defaults to loopback: the app is reached
   * through a reverse proxy that terminates TLS, so binding to every interface
   * publishes a SECOND, unencrypted way in on the app port — candidate
   * transcripts and session cookies in cleartext, bypassing the certificate
   * entirely. Set BIND_HOST=0.0.0.0 only when nothing sits in front.
   */
  bindHost: env('BIND_HOST', '127.0.0.1'),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
  authSecret: env('AUTH_SECRET', 'dev-questor-secret-change-me-please-32chars'),
  webhookSigningSecret: env('WEBHOOK_SIGNING_SECRET', 'dev-webhook-secret'),
  webhookV1Signature: parseV1SignatureSetting(env('WEBHOOK_V1_SIGNATURE')),
  signupApproverEmail: env('SIGNUP_APPROVER_EMAIL'),

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
    smtpPort: parsePortSetting('SMTP_PORT', env('SMTP_PORT', '587')),
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
