import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

  // An email provider that does not deliver is a silent failure with a human
  // cost: the recruiter is told the invitation went out, the candidate hears
  // nothing, and the gap is only discovered when someone asks why nobody
  // interviewed. Fatal in production for the same reason the secret defaults
  // are — it looks like it is working.
  if (config.email.provider === 'console' && env.ALLOW_UNDELIVERED_EMAIL !== 'true') {
    issues.push({
      level: isProd ? 'fatal' : 'warn',
      code: 'EMAIL_NOT_DELIVERED',
      message: 'EMAIL_PROVIDER is "console", which logs invitations instead of sending them. No candidate will ever receive an interview link.',
      fix: 'Set EMAIL_PROVIDER=smtp with SMTP_HOST/SMTP_USER/SMTP_PASS, or EMAIL_PROVIDER=sendgrid with SENDGRID_API_KEY. To run without email on purpose, set ALLOW_UNDELIVERED_EMAIL=true and send invitation links by hand.',
    });
  }

  issues.push(...databaseExposureIssues(isProd));

  return issues;
}

/**
 * The SQLite file holds candidate names, emails, resume text and full
 * transcripts in plaintext. Application-level authorisation is irrelevant to
 * anyone who can simply open the file, so check who can.
 */
function databaseExposureIssues(isProd: boolean): PreflightIssue[] {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) return []; // Postgres et al. are out of scope here.

  const rel = url.slice('file:'.length).split('?')[0];
  const dbPath = path.resolve(process.cwd(), 'prisma', rel);
  if (!existsSync(dbPath)) return [];

  const issues: PreflightIssue[] = [];

  // A SQLite file IS the database — anyone who can read it has every
  // transcript, regardless of what the application's authorisation says.
  // Warned rather than fatal because the fix (encryption, a dedicated host) is
  // an infrastructure decision, and refusing to boot would strand a deployment
  // that is otherwise working. It is stated on every start so it cannot be
  // quietly forgotten.
  if (isProd) {
    issues.push({
      level: 'warn',
      code: 'SQLITE_IN_PRODUCTION',
      message: 'Candidate transcripts, résumés and assessments are in a plaintext SQLite file. Anyone with filesystem access — including anything else running on this host — can read every interview without logging in.',
      fix: 'Move candidate data to a dedicated host with encryption at rest, or accept and document the risk. Note that switching to Postgres on the SAME host narrows file-permission exposure but does NOT protect against host compromise.',
    });
  }

  // Owner-only on POSIX. `stat` via Node rather than parsing `ls`, which varies
  // by distro and lies about symlinks, bind mounts and ACLs.
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(dbPath).mode & 0o777;
      // Any group or other permission at all is too much for this file.
      if (mode & 0o077) {
        issues.push({
          level: isProd ? 'fatal' : 'warn',
          code: 'DB_WORLD_READABLE',
          message: `The candidate database is mode ${mode.toString(8).padStart(3, '0')} — readable by users other than its owner. Every interview transcript on this host is exposed to any other account or service running on it.`,
          fix: `Run: chmod 600 "${dbPath}" && chmod 700 "${path.dirname(dbPath)}" — and make sure the directory is owner-only too, since SQLite writes -wal and -shm siblings next to it.`,
        });
      }
    } catch {
      // Unreadable stat is not worth failing a boot over.
    }
  }

  if (process.platform === 'win32') {
    try {
      const acl = execFileSync('icacls', [dbPath], { encoding: 'utf8', timeout: 5000 });
      // These principals mean "any account that can log into this machine".
      const broad = ['Authenticated Users', 'BUILTIN\\Users', 'Everyone']
        .filter((p) => acl.includes(p));
      if (broad.length) {
        issues.push({
          level: isProd ? 'fatal' : 'warn',
          code: 'DB_WORLD_READABLE',
          message: `The candidate database grants access to ${broad.join(', ')} — every account on this machine can read, and possibly rewrite, candidate transcripts and assessments without logging in.`,
          fix: 'Run scripts/harden-windows.ps1 in an elevated PowerShell, and enable BitLocker on this drive.',
        });
      }
    } catch {
      // icacls unavailable or blocked; not worth failing a boot over.
    }
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
