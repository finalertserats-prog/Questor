import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { hashPassword, verifyPassword, issueSession, clearSession } from '../services/auth.js';

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  // Present when signing in through an organisation's own link (/o/:slug).
  orgSlug: z.string().max(64).optional(),
});

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password, orgSlug } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !verifyPassword(password, user.passwordHash)) throw new HttpError(401, 'Invalid credentials');
  // Through an organisation link, sign-in is held to that organisation. The
  // error matches a wrong password so a link cannot be used to learn which
  // organisation an email address belongs to.
  if (orgSlug !== undefined) {
    const tenant = await prisma.tenant.findUnique({ where: { slug: orgSlug }, select: { id: true } });
    if (!tenant || tenant.id !== user.tenantId) throw new HttpError(401, 'Invalid credentials');
  }
  // Sets the httpOnly session cookie + CSRF cookie. The token is also returned
  // for non-browser clients; the web app ignores it and uses the cookie.
  const token = issueSession(res, { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  res.json({ token, user: { ...publicUser(user), tenantId: user.tenantId } });
}));

/** The fields of a user the signed-in user themselves may see. */
function publicUser(user: { id: string; name: string; email: string; role: string; tourCompletedAt: Date | null }) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, tourCompletedAt: user.tourCompletedAt?.toISOString() ?? null };
}

// `role` is deliberately NOT accepted from the request body. It previously was,
// defaulting to 'admin', which let any unauthenticated caller mint an admin
// account. The first user of a new tenant is its admin; everyone else is
// created by an admin through user management.
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12, 'Password must be at least 12 characters'),
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
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw new HttpError(409, 'Email already registered');
  const tenant = await prisma.tenant.create({ data: { name: body.tenantName ?? `${body.name}'s Org` } });
  const user = await prisma.user.create({
    data: { email: body.email, name: body.name, passwordHash: hashPassword(body.password), role: 'admin', tenantId: tenant.id },
  });
  const token = issueSession(res, { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  res.status(201).json({ token, user: { ...publicUser(user), tenantId: user.tenantId } });
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
  res.json({ user: publicUser(user), tenant: { id: tenant?.id, name: tenant?.name, region: tenant?.region, slug: tenant?.slug ?? null } });
}));

// Marks the guided tour finished (or skipped) for the caller — and only the
// caller: the user comes from the session, never from the body, so nobody can
// silence another person's first-run tour. Idempotent: the first completion is
// the one that is kept.
authRouter.post('/tour/complete', authenticate, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { tourCompletedAt: true } });
  if (!user) throw new HttpError(404, 'User not found');
  const completedAt = user.tourCompletedAt
    ?? (await prisma.user.update({ where: { id: req.auth!.userId }, data: { tourCompletedAt: new Date() }, select: { tourCompletedAt: true } })).tourCompletedAt;
  res.json({ tourCompletedAt: completedAt?.toISOString() ?? null });
}));
