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
 * What a model call is for. Every call site names one, and the name carries
 * the budget — a call site cannot be written without a bound (see
 * `GenerateJsonOptions.purpose`).
 *
 * Added after the resilience run found `work_sample` — which runs INSIDE a
 * live turn — open for 212 s with no timeout, and eight of eleven call sites
 * passing none. The only thing ending those calls was undici's 300 s default.
 */
export const LLM_PURPOSES = ['live_turn', 'authoring', 'finalisation'] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

/**
 * A candidate is sitting in silence waiting for this. It must fail early
 * enough that the next layer (local model, then the built-in writer) still
 * fits inside the turn the candidate is waiting on, so it is capped at the
 * interviewer's own ceiling rather than set beside it.
 */
export const DEFAULT_LLM_LIVE_TURN_TIMEOUT_MS = DEFAULT_INTERVIEWER_LLM_TIMEOUT_MS;
/** A person is watching a spinner on an HR screen (a JD draft, a competency). Patient, but not indefinitely. */
export const DEFAULT_LLM_AUTHORING_TIMEOUT_MS = 30_000;
/**
 * Nobody is waiting: grading, the report, evidence attribution, the feedback
 * letter, the catalog classifier. The most patient budget.
 *
 * Above every per-call setting that exists (CATALOG_CLASSIFY_TIMEOUT_MS
 * defaults to 60 s), because a call site's own timeoutMs can only SHORTEN a
 * call — so a budget equal to a setting's default would silently clamp an
 * operator who raised it. `budgetFor` says so in the log if it ever does.
 */
export const DEFAULT_LLM_FINALISATION_TIMEOUT_MS = 90_000;

export type LlmBudgets = Readonly<Record<LlmPurpose, number>>;

export function parseLlmBudgets(on: (key: string) => string | undefined): LlmBudgets {
  const liveTurn = parseTimeoutMsSetting('LLM_LIVE_TURN_TIMEOUT_MS', on('LLM_LIVE_TURN_TIMEOUT_MS'), DEFAULT_LLM_LIVE_TURN_TIMEOUT_MS);
  return {
    live_turn: liveTurn,
    authoring: parseTimeoutMsSetting('LLM_AUTHORING_TIMEOUT_MS', on('LLM_AUTHORING_TIMEOUT_MS'), DEFAULT_LLM_AUTHORING_TIMEOUT_MS),
    finalisation: parseTimeoutMsSetting('LLM_FINALISATION_TIMEOUT_MS', on('LLM_FINALISATION_TIMEOUT_MS'), DEFAULT_LLM_FINALISATION_TIMEOUT_MS),
  };
}

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

/** The daily summary's hour, 0-23; 8 when unset. Anything else refuses to start rather than mail at a surprising time. */
export function parseDigestHour(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 8;
  const hour = Number(raw.trim());
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || String(hour) !== raw.trim()) {
    throw new Error(`DIGEST_HOUR must be a whole hour from 0 to 23 (got "${raw}").`);
  }
  return hour;
}

/**
 * The cutoff invitations are reminded from, out of REMINDERS_START_AT.
 *
 * Normally unset: the reminders job stamps its own start on the first pass it
 * makes with the switch on (ReminderWindow), which is what the owner wants the
 * first time and needs no variable to be remembered. This exists for moving
 * that line afterwards — reminding from a date in the past, or holding
 * reminders off until a date ahead. A bare date is read as midnight UTC.
 *
 * Anything unparseable refuses to start rather than being read as "no cutoff",
 * which would mail every open invitation at once.
 */
/** "2026-09-24" — read as midnight UTC. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * "2026-09-24T09:00:00Z" or "...+05:30". The zone is required: without it,
 * Date reads the time on the server's own clock, so the same setting would
 * mean a different instant on a machine in another zone — and the setting
 * decides who gets mailed.
 */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseRemindersStartAt(raw: string | undefined): Date | null {
  if (raw === undefined || raw.trim() === '') return null;
  const text = raw.trim();
  // Shape first, and only these two shapes: `new Date` also accepts
  // "09/24/2026" and other loose forms, and reading a typo as a date is how a
  // cutoff ends up somewhere nobody chose.
  const at = ISO_DATE.test(text) ? new Date(`${text}T00:00:00.000Z`) : ISO_DATE_TIME.test(text) ? new Date(text) : new Date(NaN);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`REMINDERS_START_AT must be an ISO date or a date-time with a time zone, e.g. "2026-09-24" or "2026-09-24T09:00:00Z" (got "${raw}").`);
  }
  return at;
}

/** Ollama's own default listen address: on the VPS it serves loopback only. */
export const DEFAULT_LOCAL_LLM_URL = 'http://127.0.0.1:11434';
export const DEFAULT_LOCAL_LLM_MODEL = 'llama3.2:3b';
/**
 * A 3-4B model on 4 CPU cores writes a one-line acknowledgement in 2-3 s, but
 * reading the interviewer's instructions first costs several more. 12 s is the
 * same ceiling the primary gets for a spoken turn; past it the built-in writer
 * takes the turn. The Phase 0 benchmark (npm run llm:bench) sets the real number.
 */
export const DEFAULT_LOCAL_LLM_TIMEOUT_MS = 12_000;
/**
 * The local model must start speaking within this long or the built-in writer
 * takes the turn: a candidate waiting in silence is worse than a plainer line.
 */
export const DEFAULT_LOCAL_LLM_FIRST_TOKEN_MS = 8_000;
/** A primary that answers, but slower than this twice running, is treated as failing. */
export const DEFAULT_LLM_SLOW_CALL_MS = 8_000;
/** Repeated failures double the cooldown each time, up to this ceiling, so probes never storm. */
export const DEFAULT_LLM_MAX_COOLDOWN_MS = 15 * 60_000;
/** Keep the model resident: a cold load from disk on this CPU costs seconds a candidate hears. */
export const DEFAULT_LOCAL_LLM_KEEP_ALIVE = '24h';
/** How long a provider that is out of credit or refusing its key is skipped before one probe. */
export const DEFAULT_LLM_OUTAGE_COOLDOWN_MS = 5 * 60_000;
/** How long a provider that timed out, errored or was unreachable is skipped before one probe. */
export const DEFAULT_LLM_TRANSIENT_COOLDOWN_MS = 30_000;

/**
 * LOCAL_LLM_URL: where Ollama listens. Checked at start, because a typo found
 * only when the primary fails is found in the middle of an outage.
 */
export function parseLocalLlmUrlSetting(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_LOCAL_LLM_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`LOCAL_LLM_URL must be an http(s) URL such as ${DEFAULT_LOCAL_LLM_URL} (got "${raw}").`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`LOCAL_LLM_URL must be an http(s) URL such as ${DEFAULT_LOCAL_LLM_URL} (got "${raw}").`);
  }
  if (url.username || url.password) throw new Error('LOCAL_LLM_URL must not carry credentials.');
  return value.replace(/\/+$/, '');
}

/**
 * The local fallback's settings. Read only when LOCAL_LLM_ENABLED is on: with
 * it off, a leftover or mistyped LOCAL_LLM_* value must not stop a server that
 * never uses it, so the defaults stand in unread.
 */
export function parseLocalLlmSettings(read: (key: string) => string | undefined) {
  const enabled = parseBooleanSetting('LOCAL_LLM_ENABLED', read('LOCAL_LLM_ENABLED'), false);
  const on = (key: string) => (enabled ? read(key) : undefined);
  return {
    enabled,
    url: parseLocalLlmUrlSetting(on('LOCAL_LLM_URL')),
    model: on('LOCAL_LLM_MODEL')?.trim() || DEFAULT_LOCAL_LLM_MODEL,
    timeoutMs: parseTimeoutMsSetting('LOCAL_LLM_TIMEOUT_MS', on('LOCAL_LLM_TIMEOUT_MS'), DEFAULT_LOCAL_LLM_TIMEOUT_MS),
    firstTokenMs: parseTimeoutMsSetting('LOCAL_LLM_FIRST_TOKEN_MS', on('LOCAL_LLM_FIRST_TOKEN_MS'), DEFAULT_LOCAL_LLM_FIRST_TOKEN_MS),
    keepAlive: on('LOCAL_LLM_KEEP_ALIVE')?.trim() || DEFAULT_LOCAL_LLM_KEEP_ALIVE,
    outageCooldownMs: parseTimeoutMsSetting('LLM_OUTAGE_COOLDOWN_MS', on('LLM_OUTAGE_COOLDOWN_MS'), DEFAULT_LLM_OUTAGE_COOLDOWN_MS),
    transientCooldownMs: parseTimeoutMsSetting('LLM_TRANSIENT_COOLDOWN_MS', on('LLM_TRANSIENT_COOLDOWN_MS'), DEFAULT_LLM_TRANSIENT_COOLDOWN_MS),
    maxCooldownMs: parseTimeoutMsSetting('LLM_MAX_COOLDOWN_MS', on('LLM_MAX_COOLDOWN_MS'), DEFAULT_LLM_MAX_COOLDOWN_MS),
    slowCallMs: parseTimeoutMsSetting('LLM_SLOW_CALL_MS', on('LLM_SLOW_CALL_MS'), DEFAULT_LLM_SLOW_CALL_MS),
  };
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
  /**
   * Server-side pepper for the one-time identity codes emailed to candidates
   * (services/identityCode.ts). Only an HMAC of each code is stored; without
   * this secret a copy of the database cannot be searched for the code. Kept
   * apart from AUTH_SECRET so rotating one does not touch the other. Required
   * in production (preflight refuses to start without it).
   */
  identityCodePepper: env('IDENTITY_CODE_PEPPER'),
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
    /**
     * The ceiling on one model call, by what the call is for. Every call site
     * names a purpose (the type requires it), so "no timeout" is not a state
     * the code can reach.
     */
    budgets: parseLlmBudgets((key) => process.env[key]),
    /**
     * The local model (Ollama on the VPS) that takes the interviewer's
     * conversational calls when the primary fails. Off by default: off is
     * exactly the chain before it existed (primary, then built-in writer).
     */
    local: parseLocalLlmSettings((key) => process.env[key]),
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
  /**
   * HR-Box's emails (docs/RUNBOOK.md, "HR-Box reminders and daily summary").
   * Both off until the owner has seen them: candidate reminders at day 3 and
   * day 10 of the invitation plus the recruiter's expiry warning, and the
   * daily summary of what needs each HR user.
   */
  hrBox: {
    remindersEnabled: parseBooleanSetting('REMINDERS_ENABLED', process.env.REMINDERS_ENABLED, false),
    /**
     * Overrides the stamp the job wrote on its first run with the switch on.
     * Unset is the normal case; see parseRemindersStartAt.
     */
    remindersStartAt: parseRemindersStartAt(process.env.REMINDERS_START_AT),
    digestEnabled: parseBooleanSetting('DIGEST_ENABLED', process.env.DIGEST_ENABLED, false),
    /** The hour, on each organisation's own clock, from which that day's summary may go. */
    digestHour: parseDigestHour(process.env.DIGEST_HOUR),
  },
  /**
   * Monthly outcome snapshots (services/outcomeSnapshot.ts). Off until the
   * owner has decided to keep them: a snapshot outlives the candidate data it
   * was computed from, deliberately, and starting to keep records is a choice
   * an organisation makes rather than one a deploy makes for it. Aggregates
   * only — nothing in a snapshot is about a person.
   */
  outcomeSnapshotEnabled: parseBooleanSetting('OUTCOME_SNAPSHOT_ENABLED', process.env.OUTCOME_SNAPSHOT_ENABLED, false),
  /**
   * Role calibration (docs/plans/role-calibration.md): what the evaluator
   * learns from what reviewers actually decided.
   *
   * Dark by default. With `enabled` off, observations are still captured —
   * they are the record of what reviewers decided, and worth keeping whatever
   * the scoring does — but nothing is aggregated, activated or applied. An
   * organisation must ALSO switch it on in its own policy.
   *
   * `requireFairnessCheck` fails the fairness gate CLOSED: when the outcome
   * statistics cannot be read, an activation is held rather than allowed,
   * because "we could not check" is not "the check passed". Turning it off is
   * a deliberate, documented reduction in safety.
   */
  calibration: {
    enabled: parseBooleanSetting('CALIBRATION_ENABLED', process.env.CALIBRATION_ENABLED, false),
    requireFairnessCheck: parseBooleanSetting(
      'CALIBRATION_REQUIRE_FAIRNESS_CHECK', process.env.CALIBRATION_REQUIRE_FAIRNESS_CHECK, true,
    ),
    /** The shared, anonymised calibration. Off here closes it for every organisation at once. */
    globalEnabled: parseBooleanSetting('CALIBRATION_GLOBAL_ENABLED', process.env.CALIBRATION_GLOBAL_ENABLED, false),
  },
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
    /**
     * Entries the owner's daily stratified sample draws from probational and
     * live entries (Approval v2). Changes without a release.
     */
    dailySampleSize: parsePositiveIntSetting('LIBRARY_DAILY_SAMPLE_SIZE', process.env.LIBRARY_DAILY_SAMPLE_SIZE, 20),
    /** Batches the worker runs side by side; each is one generator call and one critic call. */
    workerConcurrency: parsePositiveIntSetting('LIBRARY_WORKER_CONCURRENCY', process.env.LIBRARY_WORKER_CONCURRENCY, 4),
  },
};

export type AppConfig = typeof config;
