import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import { getEmail } from '../providers/email/index.js';
import { renderIdentityCodeEmail } from '../providers/email/identityCodeEmail.js';
import { classifyEmailFailure } from '../providers/email/failure.js';
import { firstName } from '../engines/openingModel.js';
import { logAudit } from './audit.js';
import { lockSession, type TransactionClient } from './sessionLock.js';
import { demoRecipientBlocked } from './demoPolicy.js';

// Identity assurance L1: a one-time code emailed to the applicant just before
// the interview, proving whoever is about to answer controls the inbox on the
// application. Parameters follow OWASP / NIST SP 800-63B guidance for
// out-of-band codes:
//
//  - six digits from a CSPRNG;
//  - ten minutes to live, because corporate mail scanners can hold a message
//    for minutes before the candidate sees it;
//  - five entries per code, after which the code is dead and a new one waits
//    fifteen minutes;
//  - one use, consumed atomically;
//  - a resend retires every earlier code and waits a minute after the last;
//  - stored only as an HMAC under a server-side pepper, so a copy of the
//    database cannot be searched for the code.
//
// Codes are never logged, never returned by an API and never put in an error.

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const RESEND_COOLDOWN_MS = 60_000;
/** A backstop on mail to one applicant, well above what the cooldown allows a real person to need. */
export const MAX_CODES_PER_HOUR = 6;
const HOUR_MS = 60 * 60_000;
const CODE_PATTERN = /^\d{6}$/;

// Outside production only, so the zero-setup build still works. Production
// refuses to hash without a configured pepper (and preflight refuses to boot).
const DEV_PEPPER = 'questor-development-identity-code-pepper';

export function identityCodePepper(env: { nodeEnv: string; pepper: string } = { nodeEnv: config.nodeEnv, pepper: config.identityCodePepper }): string {
  const pepper = env.pepper.trim();
  if (pepper) return pepper;
  if (env.nodeEnv === 'production') {
    throw new Error('IDENTITY_CODE_PEPPER is not set; refusing to issue or check identity codes.');
  }
  return DEV_PEPPER;
}

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Bound to the interview, so the same six digits hash differently for every session. */
export function hashCode(sessionId: string, code: string): string {
  return createHmac('sha256', identityCodePepper()).update(`identity-code:v1:${sessionId}:${code}`).digest('hex');
}

/** Spaces and dashes are how people copy codes; anything else is not a code. */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

/** "p••••@example.com": enough for the candidate to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '••••';
  return `${email[0]}••••${email.slice(at)}`;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

const secondsUntil = (at: number, now: Date) => Math.max(1, Math.ceil((at - now.getTime()) / 1000));

export type IssueOutcome =
  | { kind: 'sent'; destination: string; expiresAt: Date; resendAfterSeconds: number }
  | { kind: 'already_verified' }
  | { kind: 'wait'; reason: 'cooldown' | 'locked' | 'hourly'; retryAfterSeconds: number }
  /** The address refused the message outright. Trying again changes nothing; a person has to help. */
  | { kind: 'refused' }
  /** The mail provider declined for now. Nothing was delivered; a moment later may work. */
  | { kind: 'deferred' }
  /**
   * We stopped waiting, or the connection died mid-send. The code MAY be in
   * the candidate's inbox, so it is still live and still verifies — telling
   * them "not sent" and cancelling it is what used to strand them.
   */
  | { kind: 'unconfirmed'; destination: string; expiresAt: Date; resendAfterSeconds: number }
  /** We chose not to send: a demo sandbox may only mail its own visitor. */
  | { kind: 'not_delivered' };

type Decision =
  | { kind: 'issue'; challengeId: string; code: string; retired: string[] }
  | Exclude<IssueOutcome, { kind: 'sent' } | { kind: 'refused' } | { kind: 'deferred' } | { kind: 'unconfirmed' } | { kind: 'not_delivered' }>;

async function decideIssue(sessionId: string, now: Date): Promise<Decision> {
  return prisma.$transaction(async (tx) => {
    // Two presses at once must not both pass the cooldown and send two codes.
    await lockSession(tx, sessionId);
    const confirmed = await tx.identityCodeChallenge.findFirst({ where: { sessionId, consumedAt: { not: null } }, select: { id: true } });
    if (confirmed) return { kind: 'already_verified' as const };
    const locked = await tx.identityCodeChallenge.findFirst({
      where: { sessionId, lockedAt: { gt: new Date(now.getTime() - LOCKOUT_MS) } },
      orderBy: { lockedAt: 'desc' }, select: { lockedAt: true },
    });
    if (locked?.lockedAt) return { kind: 'wait' as const, reason: 'locked' as const, retryAfterSeconds: secondsUntil(locked.lockedAt.getTime() + LOCKOUT_MS, now) };
    const recent = await tx.identityCodeChallenge.findMany({
      where: { sessionId, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    const last = recent[0];
    if (last && last.createdAt.getTime() > now.getTime() - RESEND_COOLDOWN_MS) {
      return { kind: 'wait' as const, reason: 'cooldown' as const, retryAfterSeconds: secondsUntil(last.createdAt.getTime() + RESEND_COOLDOWN_MS, now) };
    }
    if (recent.length >= MAX_CODES_PER_HOUR) {
      const oldest = recent[recent.length - 1];
      return { kind: 'wait' as const, reason: 'hourly' as const, retryAfterSeconds: secondsUntil(oldest.createdAt.getTime() + HOUR_MS, now) };
    }
    const live = await tx.identityCodeChallenge.findMany({ where: { sessionId, consumedAt: null, supersededAt: null }, select: { id: true } });
    const retired = live.map((r) => r.id);
    if (retired.length) await tx.identityCodeChallenge.updateMany({ where: { id: { in: retired } }, data: { supersededAt: now } });
    const code = generateCode();
    const row = await tx.identityCodeChallenge.create({
      data: { sessionId, channel: 'email', codeHash: hashCode(sessionId, code), expiresAt: new Date(now.getTime() + CODE_TTL_MS), createdAt: now },
      select: { id: true },
    });
    return { kind: 'issue' as const, challengeId: row.id, code, retired };
  });
}

/**
 * Take back a code whose email never went. The codes it retired come back only
 * if nothing newer was issued meanwhile (a second press whose send succeeded),
 * so a stale code can never be revived over a live one.
 */
async function undoIssue(sessionId: string, challengeId: string, retired: string[], issuedAt: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSession(tx, sessionId);
    await tx.identityCodeChallenge.deleteMany({ where: { id: challengeId } });
    const newer = await tx.identityCodeChallenge.count({ where: { sessionId, createdAt: { gte: issuedAt } } });
    if (newer === 0 && retired.length) {
      await tx.identityCodeChallenge.updateMany({ where: { id: { in: retired }, supersededAt: issuedAt }, data: { supersededAt: null } });
    }
  });
}

/**
 * Email a fresh code to the address on the application. A send that fails
 * leaves things as they were: the new code is removed, so it neither counts
 * against the cooldown nor retires a code the candidate may already hold.
 */
export async function issueIdentityCode(sessionId: string, now = new Date()): Promise<IssueOutcome> {
  const session = await prisma.interviewSession.findUnique({
    where: { id: sessionId },
    select: { tenantId: true, candidate: { select: { email: true, fullName: true } }, role: { select: { title: true } }, tenant: { select: { name: true } } },
  });
  if (!session) throw new HttpError(404, 'Invitation not found or expired');
  // The demo rule every other candidate email obeys: mail goes only to the visitor.
  if (await demoRecipientBlocked(session.tenantId, session.candidate.email)) return { kind: 'not_delivered' };
  const decision = await decideIssue(sessionId, now);
  if (decision.kind !== 'issue') return decision;

  const message = renderIdentityCodeEmail({
    to: session.candidate.email, firstName: firstName(session.candidate.fullName), roleTitle: session.role.title,
    companyName: session.tenant.name, code: decision.code, validMinutes: CODE_TTL_MS / 60_000,
  });
  const live = {
    destination: maskEmail(session.candidate.email),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    resendAfterSeconds: RESEND_COOLDOWN_MS / 1000,
  };
  try {
    await getEmail().send(message);
  } catch (err) {
    const failure = classifyEmailFailure(err);
    logger.error({ sessionId, ...failure }, 'Identity code email was not sent');
    // Audited whatever happened. Before this, a failure left NO record
    // anywhere HR looks: the challenge was deleted, so even the count of
    // codes sent showed nothing (docs/qa/resilience-2026-09-23.md, R6).
    await logAudit({
      tenantId: session.tenantId, actorType: 'system', action: 'identity.code_send_failed',
      entityType: 'InterviewSession', entityId: sessionId,
      after: { channel: 'email', certainty: failure.certainty, reason: failure.reason, detail: failure.detail },
    });
    // Only a certainty may destroy the code. An unknown outcome keeps it: the
    // candidate may be holding it, and cancelling it tells them a code they
    // can read off their screen has expired.
    if (failure.certainty === 'not_delivered') {
      await undoIssue(sessionId, decision.challengeId, decision.retired, now);
      return failure.reason === 'refused' ? { kind: 'refused' } : { kind: 'deferred' };
    }
    return { kind: 'unconfirmed', ...live };
  }
  await logAudit({
    tenantId: session.tenantId, actorType: 'system', action: 'identity.code_sent',
    entityType: 'InterviewSession', entityId: sessionId, after: { channel: 'email' },
  });
  return { kind: 'sent', ...live };
}

export type VerifyOutcome =
  | { kind: 'verified'; verifiedAt: Date }
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'expired' };

type Db = Pick<TransactionClient, 'identityCodeChallenge'>;

/** What an entry meets when there is no live code: already confirmed, locked out, or nothing to check against. */
async function outcomeWithoutLiveCode(db: Db, sessionId: string, now: Date): Promise<VerifyOutcome> {
  const confirmed = await db.identityCodeChallenge.findFirst({ where: { sessionId, consumedAt: { not: null } }, select: { consumedAt: true } });
  if (confirmed?.consumedAt) return { kind: 'verified', verifiedAt: confirmed.consumedAt };
  const locked = await db.identityCodeChallenge.findFirst({
    where: { sessionId, lockedAt: { gt: new Date(now.getTime() - LOCKOUT_MS) } },
    orderBy: { lockedAt: 'desc' }, select: { lockedAt: true },
  });
  if (locked?.lockedAt) return { kind: 'locked', retryAfterSeconds: secondsUntil(locked.lockedAt.getTime() + LOCKOUT_MS, now) };
  return { kind: 'expired' };
}

type Checked = VerifyOutcome & { readonly event?: 'confirmed' | 'locked'; readonly channel?: string };

/**
 * One entry against the live code. Runs under the session lock that issuing
 * takes, so an entry and a resend never interleave: a code a resend retires
 * cannot be counted or consumed halfway through that resend.
 */
async function checkEntry(sessionId: string, code: string, now: Date): Promise<Checked> {
  return prisma.$transaction(async (tx) => {
    await lockSession(tx, sessionId);
    const live = await tx.identityCodeChallenge.findFirst({
      where: { sessionId, consumedAt: null, supersededAt: null, lockedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!live) return outcomeWithoutLiveCode(tx, sessionId, now);

    // Counted before it is checked, and only while entries remain, so parallel
    // guesses cannot get past the limit between a read and a write (SQLite,
    // where the row lock above is a no-op, relies on this).
    const counted = await tx.identityCodeChallenge.updateMany({
      where: { id: live.id, consumedAt: null, supersededAt: null, lockedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count === 0) return outcomeWithoutLiveCode(tx, sessionId, now);

    if (sameHash(hashCode(sessionId, code), live.codeHash)) {
      const consumed = await tx.identityCodeChallenge.updateMany({
        where: { id: live.id, consumedAt: null, supersededAt: null, lockedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count === 1) return { kind: 'verified' as const, verifiedAt: now, event: 'confirmed' as const, channel: live.channel };
      return outcomeWithoutLiveCode(tx, sessionId, now);
    }

    const after = await tx.identityCodeChallenge.findUnique({ where: { id: live.id }, select: { attempts: true } });
    const attemptsLeft = MAX_ATTEMPTS - (after?.attempts ?? MAX_ATTEMPTS);
    if (attemptsLeft > 0) return { kind: 'wrong' as const, attemptsLeft };
    await tx.identityCodeChallenge.updateMany({ where: { id: live.id, consumedAt: null, lockedAt: null }, data: { lockedAt: now } });
    return { kind: 'locked' as const, retryAfterSeconds: LOCKOUT_MS / 1000, event: 'locked' as const };
  });
}

export async function verifyIdentityCode(sessionId: string, code: string, now = new Date()): Promise<VerifyOutcome> {
  const { event, channel, ...outcome } = await checkEntry(sessionId, code, now);
  if (event === 'confirmed') {
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { tenantId: true } });
    if (session) {
      await logAudit({ tenantId: session.tenantId, actorType: 'user', actorId: 'candidate', action: 'identity.code_confirmed', entityType: 'InterviewSession', entityId: sessionId, after: { channel } });
    }
  }
  if (event === 'locked') {
    logger.warn({ sessionId }, 'Identity code locked after too many wrong entries');
    // The one identity-abuse signal a reviewer would want was a log line only
    // (docs/qa/resilience-2026-09-23.md, S2). It belongs in the audit log.
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { tenantId: true } });
    if (session) {
      await logAudit({
        tenantId: session.tenantId, actorType: 'system', action: 'identity.code_locked',
        entityType: 'InterviewSession', entityId: sessionId, after: { channel: 'email', attempts: MAX_ATTEMPTS },
      });
    }
  }
  return outcome as VerifyOutcome;
}

export interface IdentityCodeStatus {
  readonly channel: 'email';
  readonly verifiedAt: Date | null;
  /** Every entry made, right or wrong. */
  readonly attempts: number;
  readonly wrongAttempts: number;
  readonly codesSent: number;
  readonly lastSentAt: Date | null;
}

export async function identityCodeStatus(sessionId: string): Promise<IdentityCodeStatus> {
  const rows = await prisma.identityCodeChallenge.findMany({
    where: { sessionId }, orderBy: { createdAt: 'asc' },
    select: { attempts: true, consumedAt: true, createdAt: true },
  });
  const verifiedAt = rows.find((r) => r.consumedAt)?.consumedAt ?? null;
  const attempts = rows.reduce((sum, r) => sum + r.attempts, 0);
  return {
    channel: 'email', verifiedAt, attempts,
    wrongAttempts: Math.max(0, attempts - (verifiedAt ? 1 : 0)),
    codesSent: rows.length,
    lastSentAt: rows.length ? rows[rows.length - 1].createdAt : null,
  };
}

export async function isIdentityConfirmed(sessionId: string): Promise<boolean> {
  return (await prisma.identityCodeChallenge.count({ where: { sessionId, consumedAt: { not: null } } })) > 0;
}
