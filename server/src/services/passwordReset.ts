import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { DEMO_ROLE } from '../domain/capabilities.js';
import { passwordProblem } from '../domain/passwordPolicy.js';
import { getEmail } from '../providers/email/index.js';
import { renderPasswordResetEmail, renderPasswordChangedEmail } from '../providers/email/passwordEmail.js';
import { hashPassword, verifyPassword } from './auth.js';
import { logAudit } from './audit.js';
import { serverPepper } from './pepper.js';
import { findUserByEmail, normalizeEmail } from './userEmail.js';

// Password reset and password change for the hiring team.
//
// Candidates have no accounts and never reach any of this: everything below is
// keyed on a User row, and a candidate is a Candidate row with an invitation
// token. The identity codes candidates enter are a separate mechanism in
// services/identityCode.ts; this file borrows its storage construction and
// touches none of its data.
//
// The parameters follow the same OWASP guidance the identity codes do:
//
//  - 256 bits from a CSPRNG, so a link cannot be guessed;
//  - one hour to live, long enough to survive a mail scanner and short enough
//    that a link left in an inbox stops working the same morning;
//  - one use, consumed by a conditional update so two presses cannot both set
//    a password;
//  - a new request retires every earlier link, and waits a minute after the
//    last one, with an hourly ceiling on top;
//  - stored only as an HMAC under the server pepper, so a copy of the database
//    is not a pile of working links.
//
// The token is never logged, never returned by an API, never put in an error
// and never written into the email's text beyond the link itself.

export const RESET_TTL_MS = 60 * 60_000;
export const RESEND_COOLDOWN_MS = 60_000;
/** A backstop above what the cooldown allows a real person to need. */
export const MAX_RESETS_PER_HOUR = 5;
const HOUR_MS = 60 * 60_000;

/** 32 bytes. The requirement is 128 bits; this is double, at no cost. */
const TOKEN_BYTES = 32;

export function generateResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The stored form of a link token.
 *
 * `password-reset:v1:` separates this from the identity codes sharing the same
 * pepper, so a hash from one feature can never be replayed against the other.
 * Unlike the identity codes there is nothing to bind to — the token IS the
 * identifier — so the hash is over the token alone and the column is unique.
 */
export function hashResetToken(token: string): string {
  return createHmac('sha256', serverPepper()).update(`password-reset:v1:${token}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The link a person follows. The token lives in the fragment — see below. */
export function resetUrl(token: string): string {
  // The fragment is the point. A query string or a path segment is written into
  // nginx's access log, into any proxy in front of it and into the browser's
  // Referer header on the next navigation — so the token would sit in plain
  // text in three places we do not control. Browsers never send the fragment to
  // the server at all, so the link works and the token is not logged anywhere.
  return `${config.webOrigin.replace(/\/+$/, '')}/reset-password#${token}`;
}

export interface RequestContext {
  /** Coarse origin of the request, recorded in the audit trail. */
  readonly ip: string;
  readonly requestId?: string;
  readonly requestedBy?: 'self' | 'admin' | 'operator';
  /** The admin or operator who asked, when it was not the account's owner. */
  readonly requestedById?: string;
}

export type RequestOutcome =
  | { kind: 'sent' }
  /** No account, or an account that cannot hold a password of its own. */
  | { kind: 'no_account' }
  | { kind: 'wait'; reason: 'cooldown' | 'hourly' }
  | { kind: 'not_delivered' };

/**
 * A demo sandbox's visitor holds a throwaway account with a random password and
 * an expiry; there is nothing there to recover, and a reset would be a way to
 * keep one alive. Treated exactly like an address with no account.
 */
function eligible(user: { role: string }): boolean {
  return user.role !== DEMO_ROLE;
}

type Decision =
  | { kind: 'issue'; tokenId: string; token: string }
  | { kind: 'wait'; reason: 'cooldown' | 'hourly' };

/**
 * Decide and write in one transaction, so two presses at once cannot both pass
 * the cooldown and mail two live links.
 */
async function decideIssue(userId: string, ctx: RequestContext, now: Date): Promise<Decision> {
  return prisma.$transaction(async (tx) => {
    const recent = await tx.passwordResetToken.findMany({
      where: { userId, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    const last = recent[0];
    if (last && last.createdAt.getTime() > now.getTime() - RESEND_COOLDOWN_MS) return { kind: 'wait', reason: 'cooldown' };
    if (recent.length >= MAX_RESETS_PER_HOUR) return { kind: 'wait', reason: 'hourly' };

    // Asking again invalidates every earlier link: a person who requests twice
    // uses the newest mail, and the older one must not stay live in an inbox.
    await tx.passwordResetToken.updateMany({
      where: { userId, consumedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });

    const token = generateResetToken();
    const row = await tx.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(now.getTime() + RESET_TTL_MS),
        requestedBy: ctx.requestedBy ?? 'self',
        requestedById: ctx.requestedById ?? '',
        createdAt: now,
      },
      select: { id: true },
    });
    return { kind: 'issue', tokenId: row.id, token };
  });
}

/**
 * Email a fresh link to an address that has an account. Answers what happened
 * for the caller's logs and tests; the HTTP routes deliberately throw every
 * outcome away and answer the same thing either way.
 */
export async function requestPasswordReset(rawEmail: string, ctx: RequestContext, now = new Date()): Promise<RequestOutcome> {
  const email = normalizeEmail(rawEmail);
  const user = await findUserByEmail(email);
  if (!user || !eligible(user)) return { kind: 'no_account' };

  const decision = await decideIssue(user.id, ctx, now);
  if (decision.kind !== 'issue') return decision;

  // Requested first, completed later — so a request that is never followed is
  // still visible to whoever is reading the trail after an incident.
  await logAudit({
    tenantId: user.tenantId, actorType: 'user',
    actorId: ctx.requestedById || user.id,
    action: ctx.requestedBy === 'self' || !ctx.requestedBy ? 'password.reset_requested' : 'password.reset_sent_by_admin',
    entityType: 'User', entityId: user.id, requestId: ctx.requestId,
    after: { ip: ctx.ip, requestedBy: ctx.requestedBy ?? 'self', expiresAt: new Date(now.getTime() + RESET_TTL_MS).toISOString() },
  });

  try {
    await getEmail().send(renderPasswordResetEmail({
      to: user.email, name: user.name, url: resetUrl(decision.token),
      validMinutes: RESET_TTL_MS / 60_000,
      sentByAdmin: ctx.requestedBy === 'admin' || ctx.requestedBy === 'operator',
    }));
  } catch (err) {
    // A link nobody received must not hold the cooldown against the next try.
    logger.error({ userId: user.id, err: err instanceof Error ? err.message : String(err) }, 'Password reset email was not sent');
    await prisma.passwordResetToken.deleteMany({ where: { id: decision.tokenId } });
    return { kind: 'not_delivered' };
  }
  return { kind: 'sent' };
}

// The public route answers before any of the work above has happened, because
// the work is not the same length for an address that has an account and one
// that does not — a reply that waits for an SMTP round trip only when the
// account exists is an account-enumeration oracle with a stopwatch for a tool.
// So nothing is awaited: the reply is a constant, and the sending happens after
// it. The set below exists so the test suite and a graceful shutdown can wait
// for that work rather than racing it.
const inFlight = new Set<Promise<unknown>>();

export function startPasswordResetRequest(rawEmail: string, ctx: RequestContext): void {
  const work = requestPasswordReset(rawEmail, ctx)
    .catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Password reset request failed');
    })
    .finally(() => inFlight.delete(work));
  inFlight.add(work);
}

/** Wait for background reset work to finish. Used by tests and shutdown. */
export async function settlePasswordResets(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

type TokenRow = { id: string; userId: string; state: 'live' | 'used' | 'retired' | 'expired' };

/**
 * The row a token names, whatever state it is in, or null.
 *
 * The lookup is an indexed match on the HMAC rather than a scan with a
 * comparison, which is what makes it fast; the explicit constant-time compare
 * afterwards is what makes it safe to have matched that way. An attacker
 * controls the token, not its HMAC, so they cannot steer the index towards a
 * neighbour of the real value and read the answer off the clock.
 *
 * The state comes back rather than being collapsed into null so a dead link can
 * be written into the audit trail against the account it belonged to. Callers
 * must not let that state reach the caller of the API: every dead state is one
 * answer on the wire.
 */
async function findToken(token: string, now: Date): Promise<TokenRow | null> {
  const hash = hashResetToken(token);
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, userId: true, tokenHash: true, expiresAt: true, consumedAt: true, supersededAt: true },
  });
  if (!row || !sameHash(hash, row.tokenHash)) return null;
  const state = row.consumedAt ? 'used'
    : row.supersededAt ? 'retired'
      : row.expiresAt.getTime() <= now.getTime() ? 'expired'
        : 'live';
  return { id: row.id, userId: row.userId, state };
}

/**
 * A link that did not work, recorded against the account it was issued for.
 *
 * Only for a token that matched a real row. A token nobody ever issued is not
 * written down at all: there is no account to record it against, and storing
 * whatever a stranger typed is how a guess ends up in an audit log.
 */
async function auditFailedReset(userId: string, reason: string, ctx: RequestContext): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  if (!user) return;
  await logAudit({
    tenantId: user.tenantId, actorType: 'user', actorId: userId, action: 'password.reset_failed',
    entityType: 'User', entityId: userId, requestId: ctx.requestId, after: { ip: ctx.ip, reason },
  });
}

/**
 * Whether the page should show the form or "this link is no longer valid".
 * Says nothing about whose account it is, or whether it ever existed.
 */
export async function resetTokenUsable(token: string, now = new Date()): Promise<boolean> {
  if (!token) return false;
  const row = await findToken(token, now);
  if (!row || row.state !== 'live') return false;
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { role: true } });
  return Boolean(user && eligible(user));
}

export type CompleteOutcome =
  | { kind: 'done'; userId: string; tenantId: string }
  /** Unknown, expired, already used, retired, or an account that has gone. */
  | { kind: 'invalid' }
  | { kind: 'weak'; message: string };

/**
 * Set a new password from a link.
 *
 * Every failure that is not "the password is too short" answers the same
 * `invalid`, so the page cannot be used to tell an expired link from a made-up
 * one — and therefore cannot be used to find out whose links are real.
 */
export async function completePasswordReset(token: string, newPassword: string, ctx: RequestContext, now = new Date()): Promise<CompleteOutcome> {
  const weak = passwordProblem(newPassword);
  if (weak) return { kind: 'weak', message: weak };

  const row = await findToken(token, now);
  // Nothing matched: no account to record it against, so nothing is written
  // down — and the caller is told what every other failure is told.
  if (!row) return { kind: 'invalid' };
  if (row.state !== 'live') {
    await auditFailedReset(row.userId, row.state, ctx);
    return { kind: 'invalid' };
  }

  // Re-read the account rather than trusting the row: between the link being
  // sent and followed the user may have been deleted, or turned into something
  // that does not hold a password of its own.
  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: { id: true, tenantId: true, role: true, email: true, name: true } });
  if (!user || !eligible(user)) return { kind: 'invalid' };

  // One conditional update is the whole race defence: two presses of the same
  // link both reach here, exactly one changes a row, and the loser is told the
  // link is no longer valid.
  const consumed = await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: row.id, consumedAt: null, supersededAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return false;
    // Only these two columns. A reset is a way back into the account it was
    // issued for and nothing else: role, tenant and email are untouched, so a
    // link can never be a way to become someone more powerful.
    // Only these two columns move. `sessionsEpoch` going up is what signs
    // every other browser out; nothing else about the account is touched.
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(newPassword), sessionsEpoch: { increment: 1 } } });
    // Any other link that was still live for this account dies with the reset.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, consumedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });
    return true;
  });
  if (!consumed) {
    // Lost a race with another press of the same link. The winner set a
    // password; this one did not, and the trail says so.
    await auditFailedReset(user.id, 'already_used', ctx);
    return { kind: 'invalid' };
  }

  await logAudit({
    tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'password.reset_completed',
    entityType: 'User', entityId: user.id, requestId: ctx.requestId, after: { ip: ctx.ip, otherSessionsEnded: true },
  });
  await notifyPasswordChanged(user, 'reset', ctx, now);
  return { kind: 'done', userId: user.id, tenantId: user.tenantId };
}

export type ChangeOutcome =
  | { kind: 'done'; sessionsEpoch: number }
  | { kind: 'wrong_current' }
  | { kind: 'same' }
  | { kind: 'weak'; message: string };

/**
 * Change your own password while signed in.
 *
 * The current password is required: a session left open on a shared office
 * machine is exactly the situation this app was built around, and without it
 * whoever sits down next could lock the owner out of their own account.
 */
export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string, ctx: RequestContext, now = new Date()): Promise<ChangeOutcome> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true, email: true, name: true, role: true, passwordHash: true } });
  // The session middleware already refused an unknown user, so this is a
  // deleted-mid-request edge rather than a path anyone reaches by asking.
  if (!user) return { kind: 'wrong_current' };

  if (!verifyPassword(currentPassword, user.passwordHash)) {
    await logAudit({
      tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'password.change_failed',
      entityType: 'User', entityId: user.id, requestId: ctx.requestId, after: { ip: ctx.ip, reason: 'wrong_current_password' },
    });
    return { kind: 'wrong_current' };
  }

  const weak = passwordProblem(newPassword);
  if (weak) return { kind: 'weak', message: weak };
  // Checked against the stored hash rather than against what was typed, so
  // "the same password in different case" is still caught as a real change.
  if (verifyPassword(newPassword, user.passwordHash)) return { kind: 'same' };

  const epoch = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(newPassword), sessionsEpoch: { increment: 1 } }, select: { sessionsEpoch: true } });
    // A password the owner has just replaced must not still be reachable
    // through a link somebody asked for earlier.
    await tx.passwordResetToken.updateMany({ where: { userId: user.id, consumedAt: null, supersededAt: null }, data: { supersededAt: now } });
    return updated.sessionsEpoch;
  });

  await logAudit({
    tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'password.changed',
    entityType: 'User', entityId: user.id, requestId: ctx.requestId, after: { ip: ctx.ip, otherSessionsEnded: true },
  });
  await notifyPasswordChanged(user, 'change', ctx, now);
  return { kind: 'done', sessionsEpoch: epoch };
}

/**
 * Tell the account holder their password moved, so a stolen account surfaces
 * through their own inbox rather than at the next quarter's audit. Carries
 * neither the new password nor any token — there is nothing in it worth
 * stealing, which is why it can be sent without ceremony.
 *
 * A failed send is logged and swallowed: the password has already changed, and
 * answering the user with an error would tell them their change did not happen.
 */
async function notifyPasswordChanged(
  user: { email: string; name: string; tenantId: string },
  how: 'reset' | 'change',
  ctx: RequestContext,
  now: Date,
): Promise<void> {
  try {
    await getEmail().send(renderPasswordChangedEmail({ to: user.email, name: user.name, how, at: now, signInUrl: `${config.webOrigin.replace(/\/+$/, '')}/login` }));
  } catch (err) {
    logger.error({ userId: ctx.requestedById || 'self', err: err instanceof Error ? err.message : String(err) }, 'Password change notification was not sent');
  }
}

/**
 * Clear ended links. They hold an HMAC and nothing else, but a table that only
 * grows is a table nobody prunes when it matters.
 */
export async function purgeEndedResetTokens(now = new Date()): Promise<number> {
  const { count } = await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - HOUR_MS) } } });
  return count;
}
