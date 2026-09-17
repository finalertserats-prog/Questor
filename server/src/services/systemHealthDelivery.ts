import { prisma } from '../db.js';
import { config } from '../config.js';
import { getEmail } from '../providers/email/index.js';
import { getLlm } from '../providers/llm/index.js';
import { sttCapability, ttsCapability, type SpeechCapability } from '../providers/speech.js';
import { legacySignatureStatus } from './webhooks.js';
import { plural, type CheckDef, type CheckOutcome, type SectionDef } from './systemHealthTypes.js';

/**
 * Operator checks on whether the deployment can do what it promises: send the
 * emails, score the interviews, and honour its deletion obligations. Mostly
 * configuration, read the same way preflight reads it; values never leave.
 */

/** Share of model calls in the last 24 h that recorded an error. */
export const MODEL_FAILURE_WARN_RATIO = 0.05;
export const MODEL_FAILURE_FAIL_RATIO = 0.25;
/** Below this many calls one bad answer is not a rate, so the check stops at warn. */
export const MODEL_FAILURE_MIN_CALLS = 10;
/** A signup nobody has answered for a day is someone waiting on us. */
export const SIGNUP_PENDING_WARN_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const isProduction = (nodeEnv: string) => nodeEnv === 'production';

const email: CheckDef = {
  id: 'email',
  label: 'Email delivery',
  run: async ({ deps }) => {
    const provider = getEmail();
    if (provider.delivers) return { status: 'ok', value: provider.name, summary: `Emails are sent through ${provider.name}.` };
    const misconfigured = config.email.provider !== 'console';
    const summary = misconfigured
      ? `EMAIL_PROVIDER names ${config.email.provider}, but its settings are incomplete, so emails are only written to the log.`
      : 'Emails are only written to the log (EMAIL_PROVIDER is console). No candidate receives an invitation.';
    const action = 'Set EMAIL_PROVIDER=smtp (SMTP_HOST, SMTP_USER, SMTP_PASS) or sendgrid (SENDGRID_API_KEY) and restart.';
    if (!isProduction(deps.nodeEnv)) return { status: 'info', value: provider.name, summary, detail: 'Expected outside production.' };
    if (!misconfigured && deps.env.ALLOW_UNDELIVERED_EMAIL === 'true') {
      return { status: 'warn', value: provider.name, summary, detail: 'ALLOW_UNDELIVERED_EMAIL=true says this is deliberate; invitation links must be sent by hand.', action };
    }
    return { status: 'fail', value: provider.name, summary, action };
  },
};

const approver: CheckDef = {
  id: 'signup-approver',
  label: 'Signup approver',
  // Only the operator sees this section, and the operator is defined by this
  // setting, so in practice it reads ok; kept so the section is complete if
  // the scope rule ever changes.
  run: async () => (config.signupApproverEmail.trim()
    ? { status: 'ok', summary: 'SIGNUP_APPROVER_EMAIL is set; new accounts and job-failure alerts reach the operator.' }
    : {
      status: 'fail', summary: 'SIGNUP_APPROVER_EMAIL is not set, so signup is closed and job-failure alerts go nowhere.',
      action: 'Set SIGNUP_APPROVER_EMAIL to the operator mailbox and restart.',
    }),
};

const llm: CheckDef = {
  id: 'llm',
  label: 'AI provider',
  run: async ({ deps }) => {
    const provider = getLlm();
    if (provider.enabled) return { status: 'ok', value: provider.name, summary: `Interviews are run and scored with ${provider.name}.` };
    const fellBack = config.llm.provider !== 'heuristic';
    const summary = fellBack
      ? `LLM_PROVIDER names ${config.llm.provider}, but its API key is missing, so the built-in heuristic engine is used.`
      : 'The built-in heuristic engine is in use (no AI provider is configured).';
    const action = 'Set LLM_PROVIDER and its API key (ANTHROPIC_API_KEY or OPENAI_API_KEY) and restart.';
    if (isProduction(deps.nodeEnv) || fellBack) return { status: 'warn', value: provider.name, summary, action };
    return { status: 'info', value: provider.name, summary };
  },
};

export function judgeModelFailures(calls: number, failures: number): CheckOutcome {
  if (calls === 0) return { status: 'info', value: 0, summary: 'No model calls in the last 24 hours.' };
  const ratio = failures / calls;
  const percent = Math.round(ratio * 1000) / 10;
  const summary = `${failures} of ${plural(calls, 'call')} failed in the last 24 hours (${percent}%).`;
  const action = 'Check the provider status page and the model execution log; a key may be exhausted or rate-limited.';
  if (ratio > MODEL_FAILURE_FAIL_RATIO) {
    return calls >= MODEL_FAILURE_MIN_CALLS
      ? { status: 'fail', value: percent, summary, action }
      : { status: 'warn', value: percent, summary, detail: `Too few calls to judge a rate; failing needs at least ${MODEL_FAILURE_MIN_CALLS}.`, action };
  }
  if (ratio > MODEL_FAILURE_WARN_RATIO) return { status: 'warn', value: percent, summary, action };
  return { status: 'ok', value: percent, summary };
}

const modelFailures: CheckDef = {
  id: 'model-failures',
  label: 'AI call failures',
  run: async ({ deps }) => {
    const since = new Date(deps.now().getTime() - DAY_MS);
    // The same failure signal the operations view uses: model calls log their
    // error into safetyJson.
    const [calls, failures] = await Promise.all([
      prisma.modelExecution.count({ where: { createdAt: { gte: since } } }),
      prisma.modelExecution.count({ where: { createdAt: { gte: since }, safetyJson: { contains: '"error"' } } }),
    ]);
    return judgeModelFailures(calls, failures);
  },
};

function speechOutcome(cap: SpeechCapability, what: string): CheckOutcome {
  if (cap.mode === 'server' && !cap.configured) {
    return {
      status: 'warn', value: cap.provider,
      summary: `${what} is set to ${cap.provider}, but its key is missing; candidates fall back to browser speech.`,
      action: 'Add the provider key named in the connector notes, or switch back to webspeech.',
    };
  }
  const where = cap.mode === 'server' ? 'on the server' : 'in the candidate’s browser';
  return { status: 'info', value: cap.provider, summary: `${cap.provider}, ${where}.` };
}

const speech: CheckDef[] = [
  { id: 'stt', label: 'Speech to text', run: async () => speechOutcome(sttCapability(), 'Speech to text') },
  { id: 'tts', label: 'Text to speech', run: async () => speechOutcome(ttsCapability(), 'Text to speech') },
];

const rateLimits: CheckDef = {
  id: 'rate-limit-store',
  label: 'Rate-limit counters',
  run: async ({ deps }) => {
    if (config.rateLimitStore === 'database') return { status: 'ok', summary: 'Shared through the database.' };
    const summary = 'Kept in this process’s memory; they reset on every restart.';
    if (!isProduction(deps.nodeEnv)) return { status: 'info', summary };
    return { status: 'warn', summary, action: 'Unset RATE_LIMIT_STORE (production defaults to database) and restart.' };
  },
};

const retention: CheckDef = {
  id: 'retention-sweep',
  label: 'Retention sweep',
  run: async ({ deps }) => (deps.env.RETENTION_SWEEP_ENABLED === 'true'
    ? { status: 'ok', summary: 'On: candidate data is deleted when its retention window ends.' }
    : {
      status: 'warn', summary: 'Off: candidate data is kept past its retention window.',
      detail: 'Deleting data when its purpose ends is a legal obligation (storage limitation).',
      action: 'Preview what would be deleted at GET /api/admin/retention/preview, then set RETENTION_SWEEP_ENABLED=true and restart.',
    }),
};

const legacyWebhooks: CheckDef = {
  id: 'webhook-v1',
  label: 'Webhook v1 signature',
  run: async () => {
    const s = await legacySignatureStatus();
    if (s.killSwitch === 'off') {
      return { status: 'info', value: 0, summary: `Switched off everywhere (WEBHOOK_V1_SIGNATURE=off); ${plural(s.flagged, 'webhook')} would get it back if switched on.` };
    }
    if (s.sending === 0) {
      return {
        status: 'info', value: 0, summary: 'No webhook on this deployment receives the v1 signature.',
        action: 'Nobody needs v1: set WEBHOOK_V1_SIGNATURE=off so it cannot come back.',
      };
    }
    return {
      status: 'info', value: s.sending,
      summary: `${plural(s.sending, 'active webhook')} still receive${s.sending === 1 ? 's' : ''} the v1 signature.`,
      detail: 'Each of those receivers breaks if the kill switch is set to off before it verifies v2.',
    };
  },
};

export const deliverySection: SectionDef = {
  id: 'delivery',
  title: 'Delivery and obligations',
  checks: [email, approver, llm, modelFailures, ...speech, rateLimits, retention, legacyWebhooks],
};

const pendingSignups: CheckDef = {
  id: 'signups-waiting',
  label: 'Account requests waiting',
  run: async ({ deps }) => {
    const before = new Date(deps.now().getTime() - SIGNUP_PENDING_WARN_MS);
    const [pending, stale] = await Promise.all([
      prisma.signupRequest.count({ where: { status: 'PENDING' } }),
      prisma.signupRequest.count({ where: { status: 'PENDING', createdAt: { lt: before } } }),
    ]);
    if (stale > 0) {
      return {
        status: 'warn', value: stale, summary: `${plural(stale, 'request')} waiting more than a day (${pending} pending in all).`,
        action: 'Open Account requests and approve or decline them.',
      };
    }
    return { status: 'ok', value: pending, summary: pending ? `${plural(pending, 'request')} pending, all less than a day old.` : 'No requests waiting.' };
  },
};

export const accountsSection: SectionDef = {
  id: 'accounts',
  title: 'Accounts',
  checks: [pendingSignups],
};
