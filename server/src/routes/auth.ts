import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isPlatformOperator, isReservedOperatorEmail } from '../middleware/platformOperator.js';
import { hashPassword, verifyPassword, issueSession, clearSession, signPendingToken, verifyPendingToken } from '../services/auth.js';
import { logAudit } from '../services/audit.js';
import { findUserByEmail, normalizeEmail } from '../services/userEmail.js';
import { capabilitiesOf } from '../domain/capabilities.js';
import { passwordSchema } from '../domain/passwordPolicy.js';
import { mfaPolicyOf, codeRequired, deviceMayStandIn } from '../domain/mfaPolicy.js';
import { issueSignInCode, verifySignInCode, consumeMfaBypass } from '../services/signInCode.js';
import { trustDevice, deviceIsTrusted, clearTrustCookie, listTrustedDevices, revokeTrustedDevice } from '../services/trustedDevice.js';
import {
  startPasswordResetRequest, resetTokenUsable, completePasswordReset, changeOwnPassword, RESET_TTL_MS,
} from '../services/passwordReset.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().email().transform(normalizeEmail),
  password: z.string().min(6),
  // Present when signing in through an organisation's own link (/o/:slug).
  orgSlug: z.string().max(64).optional(),
  /** "Keep me signed in on this device for a week." Opt-in, never assumed. */
  rememberDevice: z.boolean().optional(),
});

// Compared against when no account matches, so the response takes as long as
// a wrong password does and the timing does not say which addresses exist.
const NO_SUCH_USER_HASH = hashPassword('placeholder-compared-only-when-no-account-matches');

/**
 * Sign-in, step one: the password.
 *
 * Answers one of two things when the password is right — a session, or a
 * ticket saying a code is on its way. Which one depends on the organisation's
 * policy, the person's role and whether this browser holds a live trusted-
 * device grant. A wrong password, or an address with no account, answers
 * "Invalid credentials" either way, and takes the same time doing it.
 */
authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password, orgSlug, rememberDevice } = loginSchema.parse(req.body);
  // Case-insensitive: accounts created before addresses were normalised may
  // be stored in whatever case an admin typed.
  const user = await findUserByEmail(email);
  const passwordOk = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, NO_SUCH_USER_HASH) && false;
  if (!user || !passwordOk) {
    // Sign-ins were absent from the audit trail entirely. A failed attempt on
    // a known account is recorded against that account; an unknown address is
    // not, since recording it would store whatever a stranger typed.
    if (user) await logAudit({ tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'auth.login_failed', entityType: 'User', entityId: user.id, after: { ip: req.ip ?? 'unknown' } });
    throw new HttpError(401, 'Invalid credentials');
  }
  // Through an organisation link, sign-in is held to that organisation. The
  // error matches a wrong password so a link cannot be used to learn which
  // organisation an email address belongs to.
  const tenant = await prisma.tenant.findUnique({
    where: { id: user.tenantId },
    select: { id: true, slug: true, policyJson: true, mfaEpoch: true },
  });
  if (orgSlug !== undefined && tenant?.slug !== orgSlug) throw new HttpError(401, 'Invalid credentials');

  const policy = mfaPolicyOf(parseJsonOptional<Record<string, unknown>>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: user.tenantId, field: 'policyJson' }));
  const requirement = codeRequired({
    policy,
    role: user.role,
    platformOperator: isPlatformOperator({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email }),
  });
  const ctx = { ip: req.ip ?? 'unknown', requestId: req.requestId, reason: requirement.reason };
  const binding = {
    userId: user.id, tenantId: user.tenantId, sessionsEpoch: user.sessionsEpoch,
    role: user.role, mfaEpoch: tenant?.mfaEpoch ?? 0,
  };

  if (requirement.required) {
    // A device the person already asked us to trust, under conditions that
    // still hold. Never for the platform operator, and never for an escalation.
    const trusted = deviceMayStandIn(requirement.reason) && await deviceIsTrusted(req, binding, ctx);
    // Break-glass: a one-time, time-boxed permission the platform operator
    // grants when email is down and the code therefore cannot arrive.
    const bypassed = !trusted && await consumeMfaBypass(user, ctx);

    if (!trusted && !bypassed) {
      const issued = await issueSignInCode(user, ctx);
      if (issued.kind === 'wait') {
        throw new HttpError(429, issued.reason === 'locked'
          ? 'Too many wrong codes. Try again in a few minutes.'
          : 'A code has already been sent. Give it a moment before asking for another.', { retryAfterSeconds: issued.retryAfterSeconds });
      }
      if (issued.kind === 'not_delivered') {
        // Said plainly rather than pretending a code is coming. Somebody
        // staring at an empty inbox is the worst possible failure here.
        throw new HttpError(503, 'We could not email your sign-in code. Try again shortly, or ask your administrator.');
      }
      const pending = signPendingToken({
        userId: user.id, tenantId: user.tenantId, challengeId: issued.challengeId, remember: rememberDevice === true,
      });
      res.json({
        mfa: 'code_sent',
        pending,
        destination: issued.destination,
        expiresAt: issued.expiresAt.toISOString(),
        resendAfterSeconds: issued.resendAfterSeconds,
      });
      return;
    }
    // Recorded as its own thing, so "signed in without a code" is visible in
    // the trail rather than looking like a sign-in from an organisation with
    // no policy at all.
    await logAudit({
      tenantId: user.tenantId, actorType: 'user', actorId: user.id,
      action: trusted ? 'auth.code_skipped_trusted_device' : 'auth.mfa_bypass_used_signin',
      entityType: 'User', entityId: user.id, requestId: req.requestId, after: { ip: ctx.ip },
    });
  }

  // A device becomes trusted only by passing a real code ON it, in
  // /login/code. Not here: trusting it on a sign-in that needed no code grants
  // nothing, and trusting it on a break-glass sign-in would turn a thirty
  // minute emergency permission into a week of skipped codes.
  res.json(await completeSignIn(res, req, user, binding, ctx, { remember: false, withCode: false }));
}));

/**
 * The last step of every way in: mint the session, remember the device if a
 * code was just passed on it, and say who just signed in.
 */
async function completeSignIn(
  res: Response,
  req: Request,
  user: { id: string; tenantId: string; role: string; email: string; name: string; sessionsEpoch: number; tourCompletedAt: Date | null; digestOptOut: boolean },
  binding: { userId: string; tenantId: string; sessionsEpoch: number; role: string; mfaEpoch: number },
  ctx: { ip: string; requestId?: string },
  opts: { remember: boolean; withCode: boolean },
) {
  if (opts.remember) await trustDevice(res, req, binding, ctx);
  await logAudit({
    tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'auth.login',
    entityType: 'User', entityId: user.id, requestId: ctx.requestId,
    after: { ip: ctx.ip, withCode: opts.withCode },
  });
  // Sets the httpOnly session cookie + CSRF cookie. The token is also returned
  // for non-browser clients; the web app ignores it and uses the cookie.
  // `pv` stamps the session generation this token belongs to. Setting a
  // password increments it, and everything minted under an earlier one is
  // refused from its next request — see authenticate().
  const token = issueSession(res, { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, pv: user.sessionsEpoch });
  return { token, user: { ...publicUser(user), tenantId: user.tenantId } };
}

const codeSchema = z.object({
  pending: z.string().min(16).max(4096),
  // Trimmed of the spaces and dashes people paste; judged in the service.
  code: z.string().trim().min(1).max(32),
});

/**
 * Sign-in, step two: the code.
 *
 * Mounted at /api/auth/code rather than under /api/auth/login, so it does not
 * draw on the sign-in limiter. A person who mistypes a code twice must not find
 * they have spent the budget for entering their password.
 *
 * The challenge is named by the ticket from step one, never searched for, so an
 * entry cannot be aimed at a challenge the caller was not handed. Five wrong
 * entries kill the code and start a lockout.
 */
authRouter.post('/code', asyncHandler(async (req, res) => {
  const body = codeSchema.parse(req.body);
  const claims = verifyPendingToken(body.pending);
  // A ticket that has expired is the same answer as one that was never real:
  // start again, which is the only thing either caller can do.
  if (!claims) throw new HttpError(401, 'That sign-in has expired. Enter your password again.');

  const user = await prisma.user.findUnique({ where: { id: claims.userId } });
  if (!user || user.tenantId !== claims.tenantId) throw new HttpError(401, 'That sign-in has expired. Enter your password again.');

  const ctx = { ip: req.ip ?? 'unknown', requestId: req.requestId, reason: 'code' };
  const outcome = await verifySignInCode(claims.challengeId, user, body.code, ctx);
  if (outcome.kind === 'locked') throw new HttpError(429, 'Too many wrong codes. Try again in a few minutes.', { retryAfterSeconds: outcome.retryAfterSeconds });
  if (outcome.kind === 'expired') throw new HttpError(401, 'That code has expired. Enter your password again to get a new one.');
  if (outcome.kind === 'wrong') throw new HttpError(401, `That code is not right. ${outcome.attemptsLeft} ${outcome.attemptsLeft === 1 ? 'try' : 'tries'} left.`);

  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { mfaEpoch: true } });
  const binding = { userId: user.id, tenantId: user.tenantId, sessionsEpoch: user.sessionsEpoch, role: user.role, mfaEpoch: tenant?.mfaEpoch ?? 0 };
  res.json(await completeSignIn(res, req, user, binding, ctx, { remember: claims.remember, withCode: true }));
}));

/** The fields of a user the signed-in user themselves may see. */
function publicUser(user: { id: string; name: string; email: string; role: string; tourCompletedAt: Date | null; digestOptOut?: boolean }) {
  return {
    id: user.id, name: user.name, email: user.email, role: user.role, tourCompletedAt: user.tourCompletedAt?.toISOString() ?? null,
    // Whether the HR-Box daily summary email is switched off (Settings).
    digestOptOut: user.digestOptOut ?? false,
    // The same list requireCapability checks, so the web app can hide what
    // would only end in "permission denied" instead of mirroring the map.
    capabilities: [...capabilitiesOf(user.role)],
  };
}

// `role` is deliberately NOT accepted from the request body. It previously was,
// defaulting to 'admin', which let any unauthenticated caller mint an admin
// account. The first user of a new tenant is its admin; everyone else is
// created by an admin through user management.
const registerSchema = z.object({
  email: z.string().trim().email().transform(normalizeEmail),
  password: passwordSchema,
  name: z.string().min(1),
  tenantName: z.string().optional(),
});

authRouter.post('/register', asyncHandler(async (req, res) => {
  // Self-registration mints a tenant ADMIN. That is correct for the first user
  // of a fresh install, and dangerous on a publicly reachable deployment where
  // anyone can call it. Closed by default in production; an operator setting up
  // a new tenant opens it deliberately and briefly.
  if (config.nodeEnv === 'production' && process.env.ALLOW_SELF_REGISTRATION !== 'true') {
    throw new HttpError(403, 'Self-registration is disabled. Ask an administrator for an account.');
  }
  const body = registerSchema.parse(req.body);
  // A platform-owner address is never self-registered: the account would carry the owner's standing.
  if (isReservedOperatorEmail(body.email) || await findUserByEmail(body.email)) throw new HttpError(409, 'Email already registered');
  const tenant = await prisma.tenant.create({ data: { name: body.tenantName ?? `${body.name}'s Org` } });
  const user = await prisma.user.create({
    data: { email: body.email, name: body.name, passwordHash: hashPassword(body.password), role: 'admin', tenantId: tenant.id },
  });
  const token = issueSession(res, { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, pv: user.sessionsEpoch });
  res.status(201).json({ token, user: { ...publicUser(user), tenantId: user.tenantId } });
}));

// ---------------------------------------------------------------------------
// Password recovery.
//
// Only the hiring team has accounts. Candidates never reach any of this: they
// hold an invitation link, not a login, and the one-time codes they enter are a
// separate mechanism in services/identityCode.ts.
// ---------------------------------------------------------------------------

const forgotSchema = z.object({
  email: z.string().trim().email().transform(normalizeEmail),
});

/**
 * The one sentence this route ever says.
 *
 * It has to be identical for an address with an account, an address without
 * one, an account that cannot hold a password (a demo visitor), and a send that
 * failed — otherwise the form becomes a way to ask "does this person work
 * here?", which for a hiring tool is a question about people who have not told
 * anyone they are looking.
 */
const FORGOT_ANSWER = {
  ok: true,
  message: 'If that address has a Questor account, a link to set a new password is on its way. It works once and expires in an hour.',
} as const;

authRouter.post('/password/forgot', asyncHandler(async (req, res) => {
  const { email } = forgotSchema.parse(req.body);
  // Deliberately not awaited. Finding the account, writing the row and handing
  // the message to a mail provider all take longer for an address that has an
  // account than for one that does not, and answering after that work would
  // leak through the clock what the wording above is careful not to say.
  startPasswordResetRequest(email, { ip: req.ip ?? 'unknown', requestId: req.requestId, requestedBy: 'self' });
  res.status(202).json(FORGOT_ANSWER);
}));

// A token is a long opaque string; bounded so a megabyte of junk is rejected
// before it is hashed.
const resetTokenSchema = z.string().trim().min(16).max(256);

/**
 * Does this link still open the form?
 *
 * A POST rather than a GET with the token in the path, for the same reason the
 * link puts the token in its fragment: a path is written into every access log
 * between the browser and the app, and a body is not.
 */
authRouter.post('/password/reset/check', asyncHandler(async (req, res) => {
  const { token } = z.object({ token: resetTokenSchema }).parse(req.body);
  res.json({ usable: await resetTokenUsable(token), validMinutes: RESET_TTL_MS / 60_000 });
}));

const resetSchema = z.object({
  token: resetTokenSchema,
  // Bounded here, judged by the shared policy below. Held to `passwordSchema`
  // at this layer the rejection would arrive as the error handler's blanket
  // "Invalid request", and the person retyping would never be told the rule
  // they are failing.
  password: z.string().min(1).max(400),
});

/** What an expired, used, retired or invented link is told. Always this. */
const LINK_DEAD = 'This link is no longer valid. Request a new one from the sign-in page.';

authRouter.post('/password/reset', asyncHandler(async (req, res) => {
  const body = resetSchema.parse(req.body);
  const outcome = await completePasswordReset(body.token, body.password, { ip: req.ip ?? 'unknown', requestId: req.requestId });
  if (outcome.kind === 'weak') throw new HttpError(400, outcome.message);
  if (outcome.kind === 'invalid') throw new HttpError(400, LINK_DEAD);
  // No session is issued here. Setting a password proves control of a mailbox,
  // not of the account, and the sign-in that follows is what the audit trail
  // and the login limiter are built around. It also means a link cannot be
  // turned into a live session by anyone who merely intercepted the email.
  clearSession(res);
  res.json({ ok: true, message: 'Your password has been set. Sign in with it.' });
}));

const changeSchema = z.object({
  // Not held to the strength rule: it is whatever the account already has,
  // including an older password set before the floor moved.
  currentPassword: z.string().min(1),
  // Judged by the shared policy in the service, for the same reason as above.
  newPassword: z.string().min(1).max(400),
});

// After `authenticate`, so it keys on the person rather than on the address
// their whole office shares. Guessing the current password is the abuse here,
// and ten tries a quarter of an hour leaves an honest typo plenty of room.
const changeLimit = rateLimit({
  name: 'password-change', windowMs: 15 * 60_000, max: 10, failClosed: true,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

authRouter.post('/password/change', authenticate, changeLimit, asyncHandler(async (req, res) => {
  const body = changeSchema.parse(req.body);
  const outcome = await changeOwnPassword(req.auth!.userId, body.currentPassword, body.newPassword, {
    ip: req.ip ?? 'unknown', requestId: req.requestId,
  });
  if (outcome.kind === 'wrong_current') throw new HttpError(400, 'That is not your current password.');
  if (outcome.kind === 'weak') throw new HttpError(400, outcome.message);
  if (outcome.kind === 'same') throw new HttpError(400, 'Your new password must be different from your current one.');
  // Every session for this account has just been invalidated, including the one
  // this request arrived on. Minted again under the new generation so the
  // person who made the change is not signed out of the tab they made it in.
  issueSession(res, { userId: req.auth!.userId, tenantId: req.auth!.tenantId, role: req.auth!.role, email: req.auth!.email, pv: outcome.sessionsEpoch });
  res.json({ ok: true, message: 'Password changed. You have been signed out everywhere else.' });
}));

// ---------------------------------------------------------------------------
// Trusted devices.
//
// Yours and nobody else's: every route below is scoped to req.auth.userId, so
// there is no id an admin could pass to reach into someone else's list.
// ---------------------------------------------------------------------------

authRouter.get('/devices', authenticate, asyncHandler(async (req, res) => {
  res.json({ devices: await listTrustedDevices(req, req.auth!.userId) });
}));

authRouter.delete('/devices/:id', authenticate, asyncHandler(async (req, res) => {
  const revoked = await revokeTrustedDevice(req.auth!.userId, req.auth!.tenantId, req.params.id, {
    ip: req.ip ?? 'unknown', requestId: req.requestId,
  });
  if (!revoked) throw new HttpError(404, 'That device is not on your list.');
  // Revoking the browser you are sitting at should also stop it presenting a
  // cookie for a grant that no longer exists.
  const devices = await listTrustedDevices(req, req.auth!.userId);
  if (!devices.some((d) => d.thisDevice)) clearTrustCookie(res);
  res.json({ ok: true, devices });
}));

// Not behind `authenticate`: ending a session must work even once the token has
// already expired, and it discloses nothing — it only tells the browser to drop
// cookies it already holds. Without this the httpOnly cookie could not be
// cleared from the client at all.
authRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');
  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
  const grant = tenant?.isDemo ? await prisma.demoGrant.findFirst({ where: { tenantId: tenant.id, userId: user.id, status: 'consumed' }, orderBy: { consumedAt: 'desc' }, select: { sessionEndsAt: true } }) : null;
  res.json({ user: { ...publicUser(user), platformOperator: isPlatformOperator(req.auth) }, tenant: { id: tenant?.id, name: tenant?.name, region: tenant?.region, slug: tenant?.slug ?? null, ...(tenant?.isDemo ? { isDemo: true, sessionEndsAt: grant?.sessionEndsAt?.toISOString() ?? null } : {}) } });
}));

// Marks the guided tour finished (or skipped) for the caller — and only the
// caller: the user comes from the session, never from the body, so nobody can
// silence another person's first-run tour. Idempotent: the first completion is
// the one that is kept.
authRouter.post('/tour/complete', authenticate, asyncHandler(async (req, res) => {
  // Conditional update rather than read-then-write, so two simultaneous
  // completions still leave exactly one timestamp.
  await prisma.user.updateMany({ where: { id: req.auth!.userId, tourCompletedAt: null }, data: { tourCompletedAt: new Date() } });
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { tourCompletedAt: true } });
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ tourCompletedAt: user.tourCompletedAt?.toISOString() ?? null });
}));

// The caller's own email preferences. Only the HR-Box daily summary for now;
// strict, so a mistyped field fails instead of silently changing nothing.
const preferencesSchema = z.object({ digestOptOut: z.boolean() }).strict();

authRouter.patch('/me/preferences', authenticate, asyncHandler(async (req, res) => {
  const body = preferencesSchema.parse(req.body);
  const user = await prisma.user.update({ where: { id: req.auth!.userId }, data: { digestOptOut: body.digestOptOut }, select: { digestOptOut: true } });
  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId, action: 'user.preferences_changed',
    entityType: 'User', entityId: req.auth!.userId, after: { digestOptOut: user.digestOptOut },
  });
  res.json({ digestOptOut: user.digestOptOut });
}));
