import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { config } from '../config.js';

export interface AuthClaims {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

/**
 * Session lifetime, shortened from 12h to 1h. Questor runs on a SHARED office
 * machine holding candidate PII: a 12h token outlived the recruiter who signed
 * in, so whoever sat down next inherited a live session. There is no
 * server-side revocation list, which makes the expiry the only revocation
 * mechanism we have — so it has to be short.
 */
export const SESSION_TTL_SECONDS = 60 * 60;

export const AUTH_COOKIE = 'questor_token';
export const CSRF_COOKIE = 'questor_csrf';
/** Lowercase: Node normalises incoming header names, so this indexes req.headers directly. */
export const CSRF_HEADER = 'x-csrf-token';

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

export function verifyPassword(pw: string, hash: string): boolean {
  return bcrypt.compareSync(pw, hash);
}

export function signToken(claims: AuthClaims): string {
  return jwt.sign(claims, config.authSecret, { expiresIn: SESSION_TTL_SECONDS });
}

export function verifyToken(token: string): AuthClaims | null {
  try {
    return jwt.verify(token, config.authSecret) as AuthClaims;
  } catch {
    return null;
  }
}

/**
 * Minimal Cookie-header parser.
 *
 * Hand-rolled rather than pulling in `cookie-parser`: we need name -> value
 * lookup for exactly two cookies, not signed cookies or per-cookie options, so
 * a new runtime dependency (and its supply-chain surface) buys us nothing on a
 * server that handles candidate PII.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  // Null-prototype: a cookie literally named `constructor` must not resolve to
  // Object.prototype.constructor on lookup.
  const out = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue; // no '=' at all, or an empty name
    const name = part.slice(0, eq).trim();
    if (!name || out[name] !== undefined) continue; // first occurrence wins
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value; // malformed percent-encoding: keep the raw value rather than dropping the cookie
    }
  }
  return out;
}

/**
 * Issue the session as cookies and return the raw token.
 *
 * The token is still returned to the caller because non-browser clients (the
 * test suite, the E2E simulation script, any server-to-server integration)
 * authenticate with `Authorization: Bearer`. Browsers ignore the returned value
 * and rely on the httpOnly cookie, so no JWT is ever written to localStorage.
 */
export function issueSession(res: Response, claims: AuthClaims): string {
  const token = signToken(claims);
  const maxAge = SESSION_TTL_SECONDS * 1000;
  // `secure` only in production: dev and the test suite run over plain HTTP,
  // where a Secure cookie would be set but never sent back.
  const secure = config.nodeEnv === 'production';

  res.cookie(AUTH_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, maxAge, path: '/' });

  // Deliberately NOT httpOnly. The double-submit defence requires our own
  // first-party JS to read this value and echo it in a header; a cross-site
  // attacker can cause the cookie to be *sent* but can never *read* it, so
  // only a same-origin caller can produce the matching header.
  res.cookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), {
    httpOnly: false,
    sameSite: 'strict',
    secure,
    maxAge,
    path: '/',
  });

  return token;
}

/** Clear both session cookies. Options must match those used to set them or browsers ignore the deletion. */
export function clearSession(res: Response): void {
  const secure = config.nodeEnv === 'production';
  res.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
  res.clearCookie(CSRF_COOKIE, { httpOnly: false, sameSite: 'strict', secure, path: '/' });
}
