import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type UserInvite } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { passwordProblem } from '../domain/passwordPolicy.js';
import { isRoleName, type RoleName } from '../domain/capabilities.js';
import { getEmail } from '../providers/email/index.js';
import { renderUserInviteEmail } from '../providers/email/inviteEmail.js';
import { hashPassword } from './auth.js';
import { logAudit } from './audit.js';
import { serverPepper } from './pepper.js';
import { findUserByEmail, normalizeEmail } from './userEmail.js';

// Adding a colleague, as an emailed invitation.
//
// The alternative — an admin filling in someone else's password — is what this
// exists to avoid, and the reason is not convenience. Someone who can set
// another person's password can sign in as them, and everything that account
// does afterwards is unattributable. Attribution is what an SME review IS:
// "this expert recommended this, and this is their argument" means nothing if
// anyone with admin could have written it as them. So the admin names the
// person and the role, and the person names their own password.
//
// The token machinery is the one already proven for password reset
// (services/passwordReset.ts), with the same properties and for the same
// reasons:
//
//  - 256 bits from a CSPRNG, so an invitation cannot be guessed;
//  - stored only as an HMAC under the server pepper, so a copy of the database
//    is not a pile of working invitations;
//  - a distinct purpose prefix, so a hash lifted from one feature can never be
//    replayed against the other;
//  - carried in the URL FRAGMENT, which a browser never sends to a server, so
//    the token stays out of access logs, referrers and proxy records;
//  - one use, claimed by a conditional update, so two presses create one
//    account;
//  - never logged, never echoed to a client, never printed in a terminal.
//
// It lives longer than a reset link: a reset is answering someone who is
// standing at the door right now, an invitation is waiting for a colleague to
// read their mail. Seven days, and an admin can revoke it sooner.

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

/** 32 bytes. The requirement is 128 bits; this is double, at no cost. */
const TOKEN_BYTES = 32;

export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The stored form of an invitation token.
 *
 * `user-invite:v1:` separates this from the reset links and identity codes
 * sharing the same pepper. Without the prefix, a hash obtained from one of
 * those tables would be a working invitation here — and an invitation is worth
 * more than a reset link, because it creates an account rather than recovering
 * one.
 */
export function hashInviteToken(token: string): string {
  return createHmac('sha256', serverPepper()).update(`user-invite:v1:${token}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The link a colleague follows.
 *
 * The token is in the fragment for the same reason the reset link's is: a
 * fragment is never sent to a server, so it cannot end up in an access log, a
 * Referer header or a proxy's request record. See web/src/pages/AcceptInvite.tsx,
 * which reads it and then scrubs it out of the address bar.
 */
export function inviteUrl(token: string): string {
  return `${config.webOrigin.replace(/\/+$/, '')}/accept-invite#${token}`;
}

export type InviteOutcome =
  | { readonly kind: 'sent'; readonly invite: UserInvite }
  | { readonly kind: 'already_a_user' }
  /** Another invitation for the same address was being written at the same moment. */
  | { readonly kind: 'raced' }
  | { readonly kind: 'not_delivered' };

export interface InviteInput {
  readonly tenantId: string;
  readonly email: string;
  readonly name: string;
  readonly role: RoleName;
  readonly invitedByUserId: string;
  readonly invitedByName: string;
  readonly organisationName: string;
  readonly requestId?: string;
}

/**
 * Invite a colleague, or say why not.
 *
 * Unlike the public "forgot password" route there is no enumeration concern to
 * protect against here: the admin is looking at their own organisation's list
 * and is entitled to be told plainly that an address already has an account.
 * What they are NOT told is which organisation holds it, which is why the
 * collision answer is the same whether the account is theirs or somebody
 * else's — `User.email` is globally unique, and echoing the tenant would
 * confirm an address to an outsider who had guessed it.
 */
export async function inviteUser(input: InviteInput, now = new Date()): Promise<InviteOutcome> {
  const email = normalizeEmail(input.email);
  if (await findUserByEmail(email)) return { kind: 'already_a_user' };

  const token = generateInviteToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  // Re-inviting replaces the standing invitation rather than adding a second.
  // Two live links for one address would both work, and revoking would then
  // mean finding all of them — which is the kind of thing that is done right
  // until the day it matters. One row per address, so revoking is one delete.
  //
  // Serializable, and that is the whole point of the transaction rather than a
  // tidiness. Under the default isolation two admins pressing Send at the same
  // moment both find nothing pending to delete, both insert, and the address
  // ends up holding two working links — after which withdrawing "the"
  // invitation retires one of them and quietly leaves the other live. Postgres
  // makes the two conflict and aborts one (P2034, answered as 409 below);
  // SQLite serialises write transactions outright. The same construction as the
  // last-admin check in routes/admin.ts, for the same reason: a count or a
  // delete is only trustworthy if nothing can happen between it and the write.
  const invite = await prisma.$transaction(async (tx) => {
    await tx.userInvite.deleteMany({ where: { tenantId: input.tenantId, email, acceptedAt: null } });
    return tx.userInvite.create({
      data: {
        tenantId: input.tenantId,
        email,
        name: input.name,
        role: input.role,
        tokenHash: hashInviteToken(token),
        invitedByUserId: input.invitedByUserId,
        expiresAt,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((err: unknown) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return null;
    throw err;
  });

  if (!invite) return { kind: 'raced' };

  if (!getEmail().delivers) {
    logger.error(
      { inviteId: invite.id, provider: getEmail().name },
      'A colleague invitation was created on a deployment that cannot send email; nobody will receive it',
    );
  }

  try {
    await getEmail().send(renderUserInviteEmail({
      to: email,
      name: input.name,
      invitedBy: input.invitedByName,
      organisation: input.organisationName,
      url: inviteUrl(token),
      validDays: Math.round(INVITE_TTL_MS / (24 * 60 * 60_000)),
    }));
  } catch (err) {
    // The row is withdrawn rather than left behind. An invitation nobody
    // received is a live credential sitting in the database that its holder
    // cannot use and its author does not know exists — and the admin is about
    // to be told it failed, so a pending row would also make the list lie.
    //
    // The provider's own error text is deliberately NOT logged, unlike
    // everywhere else in this codebase that logs a send failure. The message we
    // handed it contains the link, and an HTTP client that rejects a request
    // commonly puts the request body it rejected into the error it throws — so
    // logging `err.message` here is the one plausible way a live invitation
    // token reaches a log file. The provider name and the invite id are enough
    // to find the row and the provider's own logs; the class name is enough to
    // tell a timeout from a refusal.
    logger.error(
      { inviteId: invite.id, provider: getEmail().name, errorType: err instanceof Error ? err.constructor.name : typeof err },
      'Colleague invitation email was not sent; the invitation has been withdrawn',
    );
    await prisma.userInvite.deleteMany({ where: { id: invite.id, acceptedAt: null } }).catch(() => undefined);
    return { kind: 'not_delivered' };
  }

  await logAudit({
    tenantId: input.tenantId, actorType: 'user', actorId: input.invitedByUserId,
    action: 'user.invited', entityType: 'UserInvite', entityId: invite.id,
    requestId: input.requestId,
    // The address and the role, never the token.
    after: { email, role: input.role, expiresAt: expiresAt.toISOString() },
  });

  return { kind: 'sent', invite };
}

type InviteState = 'live' | 'used' | 'expired';

interface InviteRow {
  readonly row: UserInvite;
  readonly state: InviteState;
}

async function findInvite(token: string, now: Date): Promise<InviteRow | null> {
  const hash = hashInviteToken(token);
  const row = await prisma.userInvite.findUnique({ where: { tokenHash: hash } });
  if (!row || !sameHash(hash, row.tokenHash)) return null;
  const state: InviteState = row.acceptedAt ? 'used' : row.expiresAt.getTime() <= now.getTime() ? 'expired' : 'live';
  return { row, state };
}

export interface InviteCheck {
  readonly usable: boolean;
  /** Who the invitation is for, so the page can greet them. Absent unless it is live. */
  readonly name?: string;
  readonly email?: string;
  readonly organisation?: string;
}

/**
 * What the acceptance page may know before a password is set.
 *
 * The name and address are shown so the person can tell that the link is for
 * them and not a colleague's forwarded mail — they are both already in the
 * message they followed it from, so this discloses nothing new. It is answered
 * only for a LIVE invitation: a spent or expired token gets the shape of an
 * invented one, so guessing at tokens cannot be turned into confirming that an
 * address was once invited.
 */
export async function checkInvite(token: string, now = new Date()): Promise<InviteCheck> {
  if (!token) return { usable: false };
  const found = await findInvite(token, now);
  if (!found || found.state !== 'live') return { usable: false };
  // An address that gained an account by some other route since the invitation
  // was sent — self-signup, or a second invitation accepted first.
  if (await findUserByEmail(found.row.email)) return { usable: false };
  const tenant = await prisma.tenant.findUnique({ where: { id: found.row.tenantId }, select: { name: true } });
  return { usable: true, name: found.row.name, email: found.row.email, organisation: tenant?.name ?? '' };
}

export type AcceptOutcome =
  | { readonly kind: 'done'; readonly userId: string; readonly tenantId: string }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'weak'; readonly message: string };

/**
 * Turn a live invitation into an account with a password its holder chose.
 *
 * The password is judged before the token is claimed, so a weak choice can be
 * corrected on the same link rather than burning it — the person would
 * otherwise be told "too short", press back, and find the invitation spent.
 */
export async function acceptInvite(
  token: string, password: string, ctx: { readonly ip: string; readonly requestId?: string }, now = new Date(),
): Promise<AcceptOutcome> {
  const found = await findInvite(token, now);
  if (!found || found.state !== 'live') return { kind: 'invalid' };

  const problem = passwordProblem(password);
  if (problem) return { kind: 'weak', message: problem };

  // A role that is no longer recognised resolves to NO capabilities, so an
  // invitation carrying one would create an account that cannot do anything
  // and gives no reason why. Refused as a dead link instead, which at least
  // sends the person back to the admin who can issue a new one.
  if (!isRoleName(found.row.role)) {
    logger.error({ inviteId: found.row.id, role: found.row.role }, 'A colleague invitation carries a role that no longer exists');
    return { kind: 'invalid' };
  }

  // Checked again inside the transaction below through the unique index on
  // User.email; this is the readable refusal for the ordinary case.
  if (await findUserByEmail(found.row.email)) return { kind: 'invalid' };

  const created = await prisma.$transaction(async (tx) => {
    // Claim first. Two presses of the button, or a double-submitting form,
    // both reach here; the conditional update means exactly one of them owns
    // the invitation, and the other finds count 0 and creates nothing. A
    // read-then-write would let both pass the read and both insert — one of
    // them failing on the email index afterwards, but only after the first had
    // already been told it succeeded.
    const claimed = await tx.userInvite.updateMany({
      where: { id: found.row.id, acceptedAt: null, expiresAt: { gt: now } },
      data: { acceptedAt: now },
    });
    if (claimed.count !== 1) return null;

    return tx.user.create({
      data: {
        tenantId: found.row.tenantId,
        email: found.row.email,
        name: found.row.name,
        passwordHash: hashPassword(password),
        role: found.row.role,
      },
      select: { id: true, tenantId: true },
    });
  }).catch((err: unknown) => {
    // The email index refusing is the lost half of a race, not a fault: the
    // address gained an account between the check above and this insert.
    logger.warn({ inviteId: found.row.id, err: err instanceof Error ? err.message : String(err) }, 'Accepting a colleague invitation did not create an account');
    return null;
  });

  if (!created) return { kind: 'invalid' };

  // Bookkeeping, after the account already exists. It cannot be undone by a
  // failure here, so a failure here must not be reported as the acceptance
  // having failed — the person would go back to a link that is now spent,
  // holding a password they do not know is theirs.
  try {
    await logAudit({
      tenantId: created.tenantId, actorType: 'user', actorId: created.id,
      action: 'user.invite_accepted', entityType: 'User', entityId: created.id,
      requestId: ctx.requestId,
      after: { ip: ctx.ip, inviteId: found.row.id, role: found.row.role, invitedByUserId: found.row.invitedByUserId },
    });
  } catch (err) {
    logger.error({ userId: created.id, err: err instanceof Error ? err.message : String(err) }, 'Audit after a colleague accepted an invitation failed; the account was created');
  }

  return { kind: 'done', userId: created.id, tenantId: created.tenantId };
}

export interface PendingInvite {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly invitedByUserId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly expired: boolean;
}

/** The invitations this organisation is still waiting on. Never the token, in any form. */
export async function pendingInvites(tenantId: string, now = new Date()): Promise<PendingInvite[]> {
  const rows = await prisma.userInvite.findMany({
    where: { tenantId, acceptedAt: null },
    orderBy: { createdAt: 'desc' },
    // Field by field rather than the whole row: `tokenHash` must not reach a
    // response by someone later adding a spread here.
    select: {
      id: true, name: true, email: true, role: true, invitedByUserId: true, expiresAt: true, createdAt: true,
    },
  });
  return rows.map((row) => ({ ...row, expired: row.expiresAt.getTime() <= now.getTime() }));
}

/** Withdraw an invitation that has not been accepted. Returns false if there was nothing to withdraw. */
export async function revokeInvite(tenantId: string, id: string, actorId: string, requestId?: string): Promise<boolean> {
  const { count } = await prisma.userInvite.deleteMany({ where: { id, tenantId, acceptedAt: null } });
  if (count === 0) return false;
  await logAudit({
    tenantId, actorType: 'user', actorId, action: 'user.invite_revoked',
    entityType: 'UserInvite', entityId: id, requestId,
  });
  return true;
}

/**
 * Clear out invitations that have been used or have run out.
 *
 * Runs beside the reset-token purge (services/credentialPurgeJob.ts). An
 * expired invitation cannot be accepted, so keeping it grants nothing — but it
 * is still a row holding a colleague's address and the hash of a secret, and
 * the cheapest way to not leak either is to not have them.
 *
 * An hour's grace after expiry, matching the reset purge, so a person following
 * a link that has just run out is still told "this has expired" rather than
 * "this never existed".
 */
export async function purgeEndedInvites(now = new Date()): Promise<number> {
  const HOUR_MS = 60 * 60_000;
  const { count } = await prisma.userInvite.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(now.getTime() - HOUR_MS) } },
        { acceptedAt: { lt: new Date(now.getTime() - HOUR_MS) } },
      ],
    },
  });
  return count;
}
