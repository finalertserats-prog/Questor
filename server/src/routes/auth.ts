import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isPlatformOperator, isReservedOperatorEmail } from '../middleware/platformOperator.js';
import { hashPassword, verifyPassword, issueSession, clearSession } from '../services/auth.js';
import { logAudit } from '../services/audit.js';
import { findUserByEmail, normalizeEmail } from '../services/userEmail.js';
import { capabilitiesOf } from '../domain/capabilities.js';
import { passwordSchema } from '../domain/passwordPolicy.js';
import {
  startPasswordResetRequest, resetTokenUsable, completePasswordReset, changeOwnPassword, RESET_TTL_MS,
} from '../services/passwordReset.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().trim().email().transform(normalizeEmail),
  password: z.string().min(6),
  // Present when signing in through an organisation's own link (/o/:slug).
  orgSlug: z.string().max(64).optional(),
});

// Compared against when no account matches, so the response takes as long as
// a wrong password does and the timing does not say which addresses exist.
const NO_SUCH_USER_HASH = hashPassword('placeholder-compared-only-when-no-account-matches');

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password, orgSlug } = loginSchema.parse(req.body);
  // Case-insensitive: accounts created before addresses were normalised may
  // be stored in whatever case an admin typed.
  const user = await findUserByEmail(email);
  const passwordOk = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, NO_SUCH_USER_HASH) && false;
  if (!user || !passwordOk) {
    // Sign-ins were absent from the audit trail entirely. A failed attempt on
    // a known account is recorded against that account; an unknown address is
    // not, since recording it would store whatever a stranger typed.
    if (user) await logAudit({ tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'auth.login_failed', entityType: 'User', entityId: user.id });
    throw new HttpError(401, 'Invalid credentials');
  }
  // Through an organisation link, sign-in is held to that organisation. The
  // error matches a wrong password so a link cannot be used to learn which
  // organisation an email address belongs to.
  if (orgSlug !== undefined) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: orgSlug }, select: { id: true } });
    if (!tenant || tenant.id !== user.tenantId) throw new HttpError(401, 'Invalid credentials');
  }
  // Sets the httpOnly session cookie + CSRF cookie. The token is also returned
  // for non-browser clients; the web app ignores it and uses the cookie.
  // `pv` stamps the session generation this token belongs to. Setting a
  // password increments it, and everything minted under an earlier one is
  // refused from its next request — see authenticate().
  const token = issueSession(res, { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email, pv: user.sessionsEpoch });
  await logAudit({ tenantId: user.tenantId, actorType: 'user', actorId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id });
  res.json({ token, user: { ...publicUser(user), tenantId: user.tenantId } });
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
