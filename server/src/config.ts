import 'dotenv/config';
import { REASONING_EFFORTS, type ReasoningEffort } from './providers/llm/types.js';
import { DEFAULT_REVIEW_WINDOW_HOURS } from './services/autoFeedbackModel.js';

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

/**
 * Read a non-negative whole number of hours, or refuse to start. Same
 * reasoning as the duration above: a typo here would decide how long a real
 * candidate waits for their feedback.
 */
export function parseHoursSetting(variable: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (trimmed === '' || !Number.isInteger(value) || value < 0 || value > 168) {
    throw new Error(
      `${variable} must be a whole number of hours between 0 and 168 (got "${raw}"). `
      + 'Fix the environment variable; the server will not start with an unusable window.',
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

/** A comma-separated list with blanks dropped, for address lists in env vars. */
export function parseCommaList(raw: string): string[] {
  return raw.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * A cap such as "at most 200 proposals per run". Refused rather than guessed
 * when malformed: `Number("2.5")` or a zero would quietly remove the cap that
 * keeps a monthly job from flooding the owner's queue or a paid API.
 */
export function parsePositiveIntSetting(variable: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) throw new Error(`${variable} must be a positive whole number (got "${raw}").`);
  return value;
}

/**
 * A request timeout. Under a second no real request can finish, so a value
 * like "60" (meant as seconds) would fail every call; it stops the process.
 */
export function parseTimeoutMsSetting(variable: string, raw: string | undefined, fallback: number): number {
  const value = parseDurationMsSetting(variable, raw, fallback);
  if (value < 1000) throw new Error(`${variable} must be at least 1000 milliseconds (got "${raw}").`);
  return value;
}

/** A threshold between 0 and 1. "65" meant as a percentage must not pass as 65. */
export function parseFractionSetting(variable: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${variable} must be a number between 0 and 1 (got "${raw}").`);
  return value;
}

/**
 * OPENAI_REASONING_EFFORT: how long a reasoning model (gpt-5 family, o-series)
 * thinks before an interviewer turn. Defaults to "low" because that turn is
 * spoken — a candidate hears every extra second as the interviewer not
 * listening — while grading asks for more per call. A value the API would
 * reject stops the process rather than failing every model call at runtime.
 */
export function parseReasoningEffortSetting(raw: string | undefined): ReasoningEffort {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'low';
  const known = REASONING_EFFORTS.find((e) => e === value);
  if (known) return known;
  throw new Error(`OPENAI_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')} (got "${raw}").`);
}

/** Default ceiling on one interviewer model call before the built-in question is used. */
export const DEFAULT_INTERVIEWER_LLM_TIMEOUT_MS = 12_000;

/**
 * A feature switch. Only the spellings below are accepted: "yes", "enabled"
 * or a typo would otherwise read as off (or on) and nobody would know which.
 */
export function parseBooleanSetting(variable: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'off') return false;
  throw new Error(`${variable} must be "true" or "false" (got "${raw}").`);
}

export const CRITIC_PROVIDERS = ['anthropic', 'openai'] as const;
export type CriticProvider = (typeof CRITIC_PROVIDERS)[number];

/**
 * LIBRARY_CRITIC_PROVIDER: which model family judges the library's generated
 * questions. It must differ from the generator's, so the default is Anthropic
 * (the generator is the OpenAI model LLM_PROVIDER names). The worker refuses
 * to run, rather than guess, when the two would be the same family.
 */
export function parseCriticProviderSetting(raw: string | undefined): CriticProvider {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return 'anthropic';
  const known = CRITIC_PROVIDERS.find((p) => p === value);
  if (known) return known;
  throw new Error(`LIBRARY_CRITIC_PROVIDER must be one of ${CRITIC_PROVIDERS.join(', ')} (got "${raw}").`);
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
  /**
   * How long the hiring team has to complete a review before the candidate's
   * feedback email goes out on its own. A completed review sends it at once;
   * this is only the backstop, so nobody is left waiting on a review that
   * never comes. An organisation can set its own window in tenant policy.
   */
  feedbackReviewWindowHours: parseHoursSetting('FEEDBACK_REVIEW_WINDOW_HOURS', process.env.FEEDBACK_REVIEW_WINDOW_HOURS, DEFAULT_REVIEW_WINDOW_HOURS),
  platformOperatorEmails: parseCommaList(env('PLATFORM_OPERATOR_EMAILS')).map((email) => email.toLowerCase()),
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
    openaiReasoningEffort: parseReasoningEffortSetting(process.env.OPENAI_REASONING_EFFORT),
    /**
     * How long a candidate may wait on the model for the interviewer's next
     * turn before the built-in question is used instead. A slow provider must
     * never leave someone sitting in silence mid-interview.
     */
    interviewerTimeoutMs: parseTimeoutMsSetting('INTERVIEWER_LLM_TIMEOUT_MS', process.env.INTERVIEWER_LLM_TIMEOUT_MS, DEFAULT_INTERVIEWER_LLM_TIMEOUT_MS),
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
  /**
   * The monthly shared-catalog refresh. Every cap is per run, so a restart or
   * a manual run can never multiply what one month may cost or propose.
   */
  catalogRefresh: {
    onetBaseUrl: env('CATALOG_ONET_BASE_URL', 'https://www.onetcenter.org/dl_files/database/db_31_0_csv'),
    escoBaseUrl: env('CATALOG_ESCO_BASE_URL', 'https://ec.europa.eu/esco/api'),
    maxLlmCalls: parsePositiveIntSetting('CATALOG_REFRESH_MAX_LLM_CALLS', process.env.CATALOG_REFRESH_MAX_LLM_CALLS, 150),
    maxProposals: parsePositiveIntSetting('CATALOG_REFRESH_MAX_PROPOSALS', process.env.CATALOG_REFRESH_MAX_PROPOSALS, 200),
    /** A new role below this classification confidence is skipped, not queued. */
    minConfidence: parseFractionSetting('CATALOG_REFRESH_MIN_CONFIDENCE', process.env.CATALOG_REFRESH_MIN_CONFIDENCE, 0.5),
    researchModel: env('CATALOG_RESEARCH_MODEL', 'gpt-5.5'),
    researchMaxCalls: parsePositiveIntSetting('CATALOG_RESEARCH_MAX_CALLS', process.env.CATALOG_RESEARCH_MAX_CALLS, 35),
    researchTimeoutMs: parseTimeoutMsSetting('CATALOG_RESEARCH_TIMEOUT_MS', process.env.CATALOG_RESEARCH_TIMEOUT_MS, 120_000),
    /** Model calls (classification) and research calls allowed over any 30 days, all runs together. */
    llmCallsPer30Days: parsePositiveIntSetting('CATALOG_REFRESH_LLM_CALLS_PER_30_DAYS', process.env.CATALOG_REFRESH_LLM_CALLS_PER_30_DAYS, 150),
    researchCallsPer30Days: parsePositiveIntSetting('CATALOG_RESEARCH_CALLS_PER_30_DAYS', process.env.CATALOG_RESEARCH_CALLS_PER_30_DAYS, 35),
    /** At most this share of a run's proposals may be alternative titles, so new roles always get room. */
    maxAliasShare: parseFractionSetting('CATALOG_REFRESH_MAX_ALIAS_SHARE', process.env.CATALOG_REFRESH_MAX_ALIAS_SHARE, 0.6),
    /** Minimum gap between two manual runs. */
    manualRunGapMs: parseDurationMsSetting('CATALOG_MANUAL_RUN_GAP_MS', process.env.CATALOG_MANUAL_RUN_GAP_MS, 60 * 60_000),
    /** Timeout for the classification model call. */
    classifyTimeoutMs: parseTimeoutMsSetting('CATALOG_CLASSIFY_TIMEOUT_MS', process.env.CATALOG_CLASSIFY_TIMEOUT_MS, 60_000),
    /** ESCO occupations per page; one page is one chunk. */
    escoLimit: parsePositiveIntSetting('CATALOG_ESCO_LIMIT', process.env.CATALOG_ESCO_LIMIT, 25),
    escoPagesPerRun: parsePositiveIntSetting('CATALOG_ESCO_PAGES_PER_RUN', process.env.CATALOG_ESCO_PAGES_PER_RUN, 8),
    /** Existing catalog roles looked up by title in ESCO per run, for alternative labels. */
    escoRoleLookupsPerRun: parsePositiveIntSetting('CATALOG_ESCO_ROLE_LOOKUPS_PER_RUN', process.env.CATALOG_ESCO_ROLE_LOOKUPS_PER_RUN, 40),
    /** Pause between ESCO requests: a free public API, asked politely and one at a time. */
    escoDelayMs: parseDurationMsSetting('CATALOG_ESCO_DELAY_MS', process.env.CATALOG_ESCO_DELAY_MS, 500),
    fetchTimeoutMs: parseTimeoutMsSetting('CATALOG_FETCH_TIMEOUT_MS', process.env.CATALOG_FETCH_TIMEOUT_MS, 60_000),
  },
  /**
   * The Question & Answer Library (docs/plans/question-answer-library-plan-v2.md).
   * Dark by default: with both switches off the API mounts only its status
   * route and the worker process exits at start. Caps are what the worker may
   * spend, not what it will: it stops at the cap and resumes the next day.
   */
  library: {
    /** Tenant-facing read API (select, entries) and the admin screen. */
    enabled: parseBooleanSetting('LIBRARY_ENABLED', process.env.LIBRARY_ENABLED, false),
    /** The fill worker (its own process) and, with it, the admin screen. */
    workerEnabled: parseBooleanSetting('LIBRARY_WORKER_ENABLED', process.env.LIBRARY_WORKER_ENABLED, false),
    /** Model calls (generator + critic together) the worker may make per UTC day. */
    dailyCallCap: parsePositiveIntSetting('LIBRARY_DAILY_CALL_CAP', process.env.LIBRARY_DAILY_CALL_CAP, 3000),
    /** Tokens (in + out, both models) over any rolling 30 days. */
    monthlyTokenCap: parsePositiveIntSetting('LIBRARY_MONTHLY_TOKEN_CAP', process.env.LIBRARY_MONTHLY_TOKEN_CAP, 100_000_000),
    criticProvider: parseCriticProviderSetting(process.env.LIBRARY_CRITIC_PROVIDER),
    criticModel: env('LIBRARY_CRITIC_MODEL', 'claude-sonnet-5'),
    /** Batches the worker runs side by side; each is one generator call and one critic call. */
    workerConcurrency: parsePositiveIntSetting('LIBRARY_WORKER_CONCURRENCY', process.env.LIBRARY_WORKER_CONCURRENCY, 4),
  },
};

export type AppConfig = typeof config;
