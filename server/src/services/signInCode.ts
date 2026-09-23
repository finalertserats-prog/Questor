import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { renderSignInCodeEmail } from '../providers/email/signInCodeEmail.js';
import { logAudit } from './audit.js';
import { serverPepper } from './pepper.js';

// The six digits a person enters after their password.
//
// The same construction the candidate identity codes use (services/identityCode
// .ts), deliberately: one pepper, one hashing scheme, one set of parameters to
// reason about. It is a separate table because it is a separate thing — this
// one is keyed on a User and stands between a correct password and a session;
// that one is keyed on an InterviewSession and stands between a candidate and
// an interview room. Nothing here reads or writes a candidate's row.
//
// Six digits rather than four. Four is 10,000 possibilities, and the attack
// that matters is not guessing one person's code but spraying one code across
// many accounts: with four digits, one guess against 10,000 signed-in-as-far-as
// -the-password accounts is expected to land. Six makes that a hundred times
// harder for two more characters of typing.
//
// The code is never logged, never returned by an API and never put in an error.

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const RESEND_COOLDOWN_MS = 60_000;
/** A backstop on mail to one account, above what the cooldown allows. */
export const MAX_CODES_PER_HOUR = 6;
const HOUR_MS = 60 * 60_000;
const CODE_PATTERN = /^\d{6}$/;

export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Bound to the challenge, so the same six digits hash differently for every
 * attempt — and `sign-in-code:v1:` separates this from the candidate codes and
 * the reset links sharing the pepper.
 */
export function hashCode(challengeId: string, code: string): string {
  return createHmac('sha256', serverPepper()).update(`sign-in-code:v1:${challengeId}:${code}`).digest('hex');
}

/** Spaces and dashes are how people copy codes; anything else is not a code. */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : null;
}

/** "p••••@example.com": enough to recognise, not enough to harvest. */
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

export interface CodeContext {
  readonly ip: string;
  readonly requestId?: string;
  /** Why this sign-in needs a code; recorded, and shown on the page. */
  readonly reason: string;
}

export type IssueOutcome =
  | { kind: 'sent'; challengeId: string; destination: string; expiresAt: Date; resendAfterSeconds: number }
  | { kind: 'wait'; reason: 'cooldown' | 'locked' | 'hourly'; retryAfterSeconds: number }
  | { kind: 'not_delivered' };

type Decision =
  | { kind: 'issue'; challengeId: string; code: string }
  | Exclude<IssueOutcome, { kind: 'sent' } | { kind: 'not_delivered' }>;

/**
 * Decide and write in one transaction, so two sign-in attempts at once cannot
 * both pass the cooldown and mail two live codes.
 */
async function decideIssue(userId: string, now: Date): Promise<Decision> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.signInChallenge.findFirst({
      where: { userId, lockedAt: { gt: new Date(now.getTime() - LOCKOUT_MS) } },
      orderBy: { lockedAt: 'desc' }, select: { lockedAt: true },
    });
    if (locked?.lockedAt) return { kind: 'wait', reason: 'locked', retryAfterSeconds: secondsUntil(locked.lockedAt.getTime() + LOCKOUT_MS, now) };

    const recent = await tx.signInChallenge.findMany({
      where: { userId, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true, consumedAt: true },
    });
    // The cooldown looks only at codes that were never used. A code that WAS
    // used is a sign-in that finished, and holding the next one against it
    // means signing out and back in within a minute — on a second machine, or
    // after a mistake — is met with "a code has already been sent" and no code.
    // The hourly ceiling below still counts every send, because that one is
    // about how much mail one account can cause.
    const lastUnused = recent.find((row) => row.consumedAt === null);
    if (lastUnused && lastUnused.createdAt.getTime() > now.getTime() - RESEND_COOLDOWN_MS) {
      return { kind: 'wait', reason: 'cooldown', retryAfterSeconds: secondsUntil(lastUnused.createdAt.getTime() + RESEND_COOLDOWN_MS, now) };
    }
    if (recent.length >= MAX_CODES_PER_HOUR) {
      const oldest = recent[recent.length - 1];
      return { kind: 'wait', reason: 'hourly', retryAfterSeconds: secondsUntil(oldest.createdAt.getTime() + HOUR_MS, now) };
    }

    // A new code retires every earlier one: whoever asked twice uses the newest
    // mail, and the older code must not stay live in an inbox.
    await tx.signInChallenge.updateMany({ where: { userId, consumedAt: null, supersededAt: null }, data: { supersededAt: now } });

    const code = generateCode();
    // Created first, hashed against its own id — so the row exists before the
    // hash that names it does.
    const row = await tx.signInChallenge.create({
      data: { userId, codeHash: '', expiresAt: new Date(now.getTime() + CODE_TTL_MS), createdAt: now },
      select: { id: true },
    });
    await tx.signInChallenge.update({ where: { id: row.id }, data: { codeHash: hashCode(row.id, code) } });
    return { kind: 'issue', challengeId: row.id, code };
  });
}

/**
 * Email a fresh code to the address on the account. A send that fails takes the
 * code back, so it neither holds the cooldown against the next attempt nor
 * retires a code the person may already have.
 */
export async function issueSignInCode(
  user: { id: string; tenantId: string; email: string; name: string },
  ctx: CodeContext,
  now = new Date(),
): Promise<IssueOutcome> {
  const decision = await decideIssue(user.id, now);
  if (decision.kind !== 'issue') return decision;

  try {
    await getEmail().send(renderSignInCodeEmail({
      to: user.email, name: user.name, code: decision.code,
      validMinutes: CODE_TTL_MS / 60_000, ip: ctx.ip,
    }));
  } catch (err) {
    logger.error({ userId: user.id, err: err instanceof Error ? err.message : String(err) }, 'Sign-in code email was not sent');
    await prisma.signInChallenge.deleteMany({ where: { id: decision.challengeId } });
    return { kind: 'not_delivered' };
  }

  await logAudit({
    tenantId: user.tenantId, actorType: 'system', actorId: user.id, action: 'auth.code_sent',
    entityType: 'User', entityId: user.id, requestId: ctx.requestId,
    after: { ip: ctx.ip, reason: ctx.reason },
  });
  return {
    kind: 'sent', challengeId: decision.challengeId, destination: maskEmail(user.email),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS), resendAfterSeconds: RESEND_COOLDOWN_MS / 1000,
  };
}

export type VerifyOutcome =
  | { kind: 'verified' }
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'locked'; retryAfterSeconds: number }
  | { kind: 'expired' };

type Checked = VerifyOutcome & { readonly event?: 'locked' };

/**
 * One entry against one challenge.
 *
 * The attempt is counted BEFORE the code is checked, and only while attempts
 * remain, so parallel guesses cannot slip between a read and a write. The
 * challenge id is supplied by the caller (out of the pending token), so this
 * never searches for "the live challenge" — an attacker cannot aim an entry at
 * a challenge they were not handed.
 */
async function checkEntry(challengeId: string, userId: string, code: string, now: Date): Promise<Checked> {
  return prisma.$transaction(async (tx) => {
    const live = await tx.signInChallenge.findFirst({
      where: { id: challengeId, userId, consumedAt: null, supersededAt: null, lockedAt: null, expiresAt: { gt: now } },
    });
    if (!live) return { kind: 'expired' };

    const counted = await tx.signInChallenge.updateMany({
      where: { id: live.id, consumedAt: null, supersededAt: null, lockedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count === 0) return { kind: 'expired' };

    if (sameHash(hashCode(live.id, code), live.codeHash)) {
      const consumed = await tx.signInChallenge.updateMany({
        where: { id: live.id, consumedAt: null, supersededAt: null, lockedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      // Exactly one entry consumes it; a second press of the same button is
      // told the code is spent rather than being handed a second session.
      return consumed.count === 1 ? { kind: 'verified' } : { kind: 'expired' };
    }

    const after = await tx.signInChallenge.findUnique({ where: { id: live.id }, select: { attempts: true } });
    const attemptsLeft = MAX_ATTEMPTS - (after?.attempts ?? MAX_ATTEMPTS);
    if (attemptsLeft > 0) return { kind: 'wrong', attemptsLeft };
    await tx.signInChallenge.updateMany({ where: { id: live.id, consumedAt: null, lockedAt: null }, data: { lockedAt: now } });
    return { kind: 'locked', retryAfterSeconds: LOCKOUT_MS / 1000, event: 'locked' };
  });
}

export async function verifySignInCode(
  challengeId: string,
  user: { id: string; tenantId: string },
  rawCode: string,
  ctx: CodeContext,
  now = new Date(),
): Promise<VerifyOutcome> {
  const code = normalizeCode(rawCode);
  // A code that is not six digits is not compared against anything, and is
  // still counted as a wrong entry by the caller's rate limiter — otherwise
  // "aaaaaa" would be a free probe.
  if (!code) return { kind: 'wrong', attemptsLeft: MAX_ATTEMPTS };

  const { event, ...outcome } = await checkEntry(challengeId, user.id, code, now);
  if (outcome.kind === 'verified') {
    await logAudit({
      tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'auth.code_confirmed',
      entityType: 'User', entityId: user.id, requestId: ctx.requestId, after: { ip: ctx.ip },
    });
  } else {
    await logAudit({
      tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'auth.code_failed',
      entityType: 'User', entityId: user.id, requestId: ctx.requestId, after: { ip: ctx.ip, outcome: outcome.kind },
    });
  }
  if (event === 'locked') logger.warn({ userId: user.id }, 'Sign-in code locked after too many wrong entries');
  return outcome as VerifyOutcome;
}

/**
 * Break-glass: the one-time, time-boxed permission to sign in without a code.
 *
 * It exists because the second factor is email, and email is a thing that
 * breaks. Without this, a mail outage or a mailbox that has stopped accepting
 * our messages locks an organisation's admins out of their own product, and
 * the only remedy would be found during the incident, by someone with database
 * access, under pressure. Better to decide it now, in daylight, with a bound
 * and a trail.
 *
 * Granted only by the platform operator, for one named person, for thirty
 * minutes, and cleared the moment it is used. It skips the CODE, never the
 * PASSWORD: whoever uses it still has to know the password, so a grant handed
 * to the wrong person is not on its own a way in.
 */
export const BYPASS_WINDOW_MS = 30 * 60_000;

export async function grantMfaBypass(
  target: { id: string; tenantId: string; email: string },
  operator: { id: string },
  ctx: { ip: string; requestId?: string; reason: string },
  now = new Date(),
): Promise<Date> {
  const until = new Date(now.getTime() + BYPASS_WINDOW_MS);
  await prisma.user.update({ where: { id: target.id }, data: { mfaBypassUntil: until } });
  await logAudit({
    tenantId: target.tenantId, actorType: 'user', actorId: operator.id, action: 'auth.mfa_bypass_granted',
    entityType: 'User', entityId: target.id, requestId: ctx.requestId,
    after: { ip: ctx.ip, reason: ctx.reason, until: until.toISOString(), minutes: BYPASS_WINDOW_MS / 60_000 },
  });
  return until;
}

/**
 * Spend a live bypass, if there is one. Conditional update, so two sign-ins at
 * once cannot both spend the same grant.
 */
export async function consumeMfaBypass(
  user: { id: string; tenantId: string; mfaBypassUntil: Date | null },
  ctx: { ip: string; requestId?: string },
  now = new Date(),
): Promise<boolean> {
  if (!user.mfaBypassUntil || user.mfaBypassUntil.getTime() <= now.getTime()) return false;
  const spent = await prisma.user.updateMany({
    where: { id: user.id, mfaBypassUntil: { gt: now } },
    data: { mfaBypassUntil: null },
  });
  if (spent.count !== 1) return false;
  await logAudit({
    tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'auth.mfa_bypass_used',
    entityType: 'User', entityId: user.id, requestId: ctx.requestId, after: { ip: ctx.ip },
  });
  return true;
}

/** Clear ended challenges. They hold an HMAC and nothing else, but a table that only grows is one nobody prunes. */
export async function purgeEndedSignInChallenges(now = new Date()): Promise<number> {
  const { count } = await prisma.signInChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - HOUR_MS) } } });
  return count;
}
