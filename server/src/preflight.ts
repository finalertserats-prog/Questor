import { config } from './config.js';
import { logger } from './logger.js';

// Boot-time safety gate. Questor stores real candidate personal data
// (resumes, transcripts, assessments), so an unsafe production boot is a data
// breach waiting to happen rather than a configuration nit. In production the
// process refuses to start; in development we warn loudly and continue so the
// zero-setup demo path still works.

const DEV_DEFAULTS = new Set([
  'dev-questor-secret-change-me-please-32chars',
  'dev-webhook-secret',
]);

export interface PreflightIssue {
  level: 'fatal' | 'warn';
  code: string;
  message: string;
  fix: string;
}

export function collectIssues(env: NodeJS.ProcessEnv = process.env): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const isProd = config.nodeEnv === 'production';

  if (DEV_DEFAULTS.has(config.authSecret)) {
    issues.push({
      level: isProd ? 'fatal' : 'warn',
      code: 'AUTH_SECRET_DEFAULT',
      message: 'AUTH_SECRET is the built-in development default, which is published in the public repository. Anyone can forge a session token for any user.',
      fix: 'Set AUTH_SECRET in server/.env to a unique random value, e.g. `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"`.',
    });
  } else if (config.authSecret.length < 32) {
    issues.push({
      level: isProd ? 'fatal' : 'warn',
      code: 'AUTH_SECRET_WEAK',
      message: `AUTH_SECRET is only ${config.authSecret.length} characters; it is brute-forceable.`,
      fix: 'Use at least 32 random characters.',
    });
  }

  if (DEV_DEFAULTS.has(config.webhookSigningSecret)) {
    issues.push({
      level: isProd ? 'fatal' : 'warn',
      code: 'WEBHOOK_SECRET_DEFAULT',
      message: 'WEBHOOK_SIGNING_SECRET is the published development default, so webhook signatures can be forged.',
      fix: 'Set WEBHOOK_SIGNING_SECRET in server/.env to a unique random value.',
    });
  }

  if (isProd && env.ALLOW_DEMO_SEED !== 'true') {
    issues.push({
      level: 'warn',
      code: 'DEMO_SEED',
      message: 'Demo seed data (demo@questor.local, an admin account with a published password) must not exist in production.',
      fix: 'Run `npm run db:seed -w server` only on development machines. Delete the demo user before going live.',
    });
  }

  if (isProd && config.webOrigin.startsWith('http://') && !config.webOrigin.includes('localhost')) {
    issues.push({
      level: 'fatal',
      code: 'INSECURE_ORIGIN',
      message: `WEB_ORIGIN is plain HTTP (${config.webOrigin}). Candidate personal data and session tokens would cross the network unencrypted.`,
      fix: 'Serve the web app over HTTPS and set WEB_ORIGIN accordingly.',
    });
  }

  // Candidate data leaves the machine when a hosted LLM is configured. That is a
  // processor relationship under GDPR/DPDP and needs a signed agreement.
  if (config.llm.provider !== 'heuristic' && (config.llm.anthropicKey || config.llm.openaiKey)) {
    issues.push({
      level: 'warn',
      code: 'LLM_DATA_TRANSFER',
      message: `Interview transcripts are sent to ${config.llm.provider} for scoring. This is a third-party processor and, for EU/UK/India candidates, an international data transfer.`,
      fix: 'Ensure a data processing agreement is in place with the provider, that training on your data is disabled, and that candidates are told in the consent notice.',
    });
  }

  return issues;
}

/** Run the gate. Throws in production when a fatal issue is present. */
export function preflight(env: NodeJS.ProcessEnv = process.env): PreflightIssue[] {
  const issues = collectIssues(env);
  const fatal = issues.filter((i) => i.level === 'fatal');

  for (const i of issues.filter((i) => i.level === 'warn')) {
    logger.warn(`[preflight] ${i.code}: ${i.message}  Fix: ${i.fix}`);
  }
  for (const i of fatal) {
    logger.error(`[preflight] ${i.code}: ${i.message}  Fix: ${i.fix}`);
  }

  if (fatal.length) {
    throw new Error(
      `Refusing to start: ${fatal.length} fatal configuration problem(s) — ${fatal.map((i) => i.code).join(', ')}. ` +
      'Questor handles real candidate personal data and will not run with these unresolved.',
    );
  }
  return issues;
}
