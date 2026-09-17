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

/**
 * Read a non-negative whole number of milliseconds, or refuse to start.
 *
 * Same reasoning as the port: `Number("")` is 0 and `parseInt("20m")` is 20, so
 * a typo would silently turn a twenty-minute shutdown drain into none at all —
 * and the next deploy would end every interview in progress.
 */
export function parseDurationMsSetting(variable: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `${variable} must be a whole number of milliseconds, 0 or more (got "${raw}"). `
      + 'Fix the environment variable; the server will not start with an unusable duration.',
    );
  }
  return value;
}

export type RateLimitStoreKind = 'database' | 'memory';

/**
 * Where rate-limit counters live. Production shares them through the database
 * so that a second instance does not double every limit; tests and local
 * development keep them in memory unless they opt in. An unknown value stops
 * the process rather than quietly falling back to per-process counters.
 */
export function parseRateLimitStore(raw: string | undefined, nodeEnv: string): RateLimitStoreKind {
  const value = raw?.trim();
  if (!value) return nodeEnv === 'production' ? 'database' : 'memory';
  if (value === 'database' || value === 'memory') return value;
  throw new Error(`RATE_LIMIT_STORE must be "database" or "memory" (got "${raw}").`);
}

/** Twenty minutes: long enough for most interviews in progress to finish. */
export const DEFAULT_SHUTDOWN_DRAIN_MS = 20 * 60_000;

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
  signupApproverEmail: env('SIGNUP_APPROVER_EMAIL'),
  /**
   * How long a stopping process waits for interviews it is serving to end
   * before it exits anyway. pm2's kill timeout must be longer than this, or
   * pm2 SIGKILLs the process mid-drain (scripts/deploy.sh passes it).
   */
  shutdownDrainMs: parseDurationMsSetting('SHUTDOWN_DRAIN_MS', process.env.SHUTDOWN_DRAIN_MS, DEFAULT_SHUTDOWN_DRAIN_MS),
  rateLimitStore: parseRateLimitStore(process.env.RATE_LIMIT_STORE, env('NODE_ENV', 'development')),

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
    // The ATS_* variables describe ONE organisation's ATS. They are used only
    // for the tenant named here; without it they are ignored, because a
    // deployment-wide ATS let every tenant read every requisition in it.
    tenantId: env('ATS_TENANT_ID'),
  },
  meeting: {
    provider: env('MEETING_PROVIDER', 'hosted'),
  },
};

export type AppConfig = typeof config;
