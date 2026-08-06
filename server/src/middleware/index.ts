import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { nanoid } from 'nanoid';
import { capabilitiesOf, type Capability } from '../domain/capabilities.js';
import {
  verifyToken,
  parseCookies,
  AUTH_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  type AuthClaims,
} from '../services/auth.js';
import { logger } from '../logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthClaims;
      requestId?: string;
    }
  }
}

export function requestId(req: Request, _res: Response, next: NextFunction) {
  req.requestId = (req.headers['x-request-id'] as string) || nanoid(12);
  next();
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  // Two credential sources, never the query string. Accepting a token from the
  // query string leaked valid sessions into access logs, proxy logs, browser
  // history and Referer headers — on a shared machine, browser history alone
  // handed over a live session.
  const header = req.headers.authorization;
  let token: string | undefined;

  if (header !== undefined) {
    // If an Authorization header is present it is the ONLY credential
    // considered — we never fall back to the cookie when it is malformed.
    // csrfProtection exempts header-bearing requests (a browser will not attach
    // this header cross-site), so a fallback would let an attacker send a junk
    // Bearer header on a forged request to skip the CSRF check and still be
    // authenticated by the victim's cookie. This condition and the exemption in
    // csrfProtection must stay exactly in agreement.
    token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  } else {
    // Browser sessions: httpOnly cookie, unreadable by any XSS on this origin.
    token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  }

  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  const claims = verifyToken(token);
  if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
  req.auth = claims;
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const CSRF_EXEMPT_PATHS = [
  // The candidate portal is unauthenticated: there is no session to forge, and
  // candidates arrive with no cookies of ours at all.
  /^\/api\/portal(?:\/|$)/,
  // Session *establishment*, not action on an existing session. These must keep
  // working when a stale session cookie is present but the paired CSRF cookie
  // is gone (user cleared one cookie, or it expired first) — otherwise a user
  // is locked out of their own login page with a 403 they cannot clear.
  // SameSite=Strict already blocks the forged-login variant in any current browser.
  /^\/api\/auth\/(?:login|register)\/?$/,
];

/** Constant-time compare; lengths are compared first because timingSafeEqual throws on a mismatch. */
function tokensMatch(sent: string, expected: string): boolean {
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Double-submit CSRF protection for cookie-authenticated writes.
 *
 * Cookie auth is ambient: the browser attaches it to cross-site requests too,
 * so without this every state-changing route would be forgeable by any page the
 * recruiter visits while logged in. The readable CSRF cookie can be *sent* by
 * an attacker but never *read*, so only same-origin JS can produce the matching
 * header.
 *
 * Mounted app-wide, so it runs before `authenticate` and cannot consult
 * req.auth — it decides from the credentials on the wire instead.
 */
export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.some((re) => re.test(req.path))) return next();

  // Header-authenticated callers (test suite, E2E script, server-to-server
  // clients) are not CSRF-able: a browser never attaches an Authorization
  // header to a cross-site request on the attacker's behalf. Mirrors the
  // header-exclusive branch in authenticate().
  if (req.headers.authorization !== undefined) return next();

  const cookies = parseCookies(req.headers.cookie);
  // No session cookie means there is no ambient authority to abuse.
  if (!cookies[AUTH_COOKIE]) return next();

  const sent = req.headers[CSRF_HEADER];
  const expected = cookies[CSRF_COOKIE];
  if (!expected || typeof sent !== 'string' || !tokensMatch(sent, expected)) {
    logger.warn({ requestId: req.requestId, path: req.path, method: req.method }, 'CSRF check failed');
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.length && !roles.includes(req.auth.role) && req.auth.role !== 'admin') {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    next();
  };
}

/**
 * Gate a route on a capability rather than a role name.
 *
 * Unlike `requireRole` this has no implicit admin pass-through — admin holds
 * every capability explicitly in the role map, so the grant is visible in one
 * place instead of being an invisible override on every check.
 *
 * This answers only "may this user perform this KIND of action?". It does NOT
 * answer "may they touch THIS object" — routes must still scope the object via
 * services/access.ts. Both are required; either alone leaves a hole.
 */
export function requireCapability(cap: Capability) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: 'Not authenticated' });
    if (!capabilitiesOf(req.auth.role).includes(cap)) {
      return res.status(403).json({ error: 'Your account does not have permission to do that.' });
    }
    next();
  };
}

/** Wrap async route handlers to funnel errors to the error middleware. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = err.status ?? err.statusCode ?? 500;
  logger.error({ err: err?.message ?? String(err), stack: err?.stack, requestId: req.requestId, path: req.path }, 'Request error');

  // Only messages we authored are safe to return. Everything else (upstream API
  // bodies, Prisma errors, stack-bearing runtime errors) previously reached the
  // client verbatim, including on unauthenticated portal routes.
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Invalid request',
      fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      requestId: req.requestId,
    });
  }
  const safe = err instanceof HttpError ? err.message : 'Internal server error';
  res.status(err instanceof HttpError ? status : 500).json({ error: safe, requestId: req.requestId });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
