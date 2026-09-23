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
  demo?: boolean;
  demoGrantId?: string;
  /**
   * The session generation this token was minted under (User.sessionsEpoch).
   * `authenticate` refuses a token whose generation is not the account's
   * current one, which is how setting a password signs every other browser out.
   * Optional, and read as 0 when absent: tokens minted before this existed, and
   * the many tests that sign a bare claim set, are all generation zero — which
   * is what a User row that has never had a password change still holds.
   */
  pv?: number;
  /**
   * Set on a token that is NOT a session.
   *
   * The half-signed-in state between a correct password and a correct code
   * needs something to carry it across two requests, and the obvious thing to
   * reach for is the token machinery that is already here. That is also how a
   * half-signed-in state becomes a whole one by accident, so every token with a
   * purpose is refused by `authenticate` outright: a session has no purpose
   * claim, and anything that does is some other errand's ticket.
   */
  purpose?: 'signin-code';
}

/**
 * The ticket handed out after a correct password, to be presented with the
 * code. Short-lived, because it is the window an attacker who has guessed a
 * password gets to work in.
 */
export const PENDING_TTL_SECONDS = 10 * 60;

export interface PendingClaims {
  userId: string;
  tenantId: string;
  challengeId: string;
  /** Whether "keep me signed in on this device" was ticked on the password step. */
  remember: boolean;
  purpose: 'signin-code';
}

export function signPendingToken(claims: Omit<PendingClaims, 'purpose'>): string {
  return jwt.sign({ ...claims, purpose: 'signin-code' }, config.authSecret, { expiresIn: PENDING_TTL_SECONDS });
}

export function verifyPendingToken(token: string): PendingClaims | null {
  try {
    const claims = jwt.verify(token, config.authSecret, { algorithms: ['HS256'] }) as PendingClaims;
    // Checked here as well as in `authenticate`: a session token presented as a
    // pending one would otherwise let someone skip straight past the code step
    // with a ticket they already held.
    return claims.purpose === 'signin-code' ? claims : null;
  } catch {
    return null;
  }
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

export function signToken(claims: AuthClaims, opts: { ttlSeconds?: number } = {}): string {
  return jwt.sign(claims, config.authSecret, { expiresIn: opts.ttlSeconds ?? SESSION_TTL_SECONDS });
}

export function verifyToken(token: string): AuthClaims | null {
  try {
    // A string secret already confines jsonwebtoken to HMAC; pinning the
    // algorithm keeps that true if the secret ever becomes a key object.
    return jwt.verify(token, config.authSecret, { algorithms: ['HS256'] }) as AuthClaims;
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
export function issueSession(res: Response, claims: AuthClaims, opts: { ttlSeconds?: number } = {}): string {
  const ttlSeconds = opts.ttlSeconds ?? SESSION_TTL_SECONDS;
  const token = signToken(claims, { ttlSeconds });
  const maxAge = ttlSeconds * 1000;
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
