import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import type { AuthClaims } from '../services/auth.js';

/**
 * The platform owner: whoever PLATFORM_OPERATOR_EMAILS names. Organisation
 * roles say nothing here, because the shared catalog belongs to every
 * organisation at once and an admin of one must not edit it for all.
 * Fails closed: with the setting empty, nobody is an operator.
 */

function operatorEmails(): ReadonlySet<string> {
  // Read per call so a changed setting (and a test) takes effect at once.
  return new Set(config.platformOperatorEmails.map((email) => email.trim().toLowerCase()).filter((email) => email.length > 0));
}

export function isPlatformOperator(auth: AuthClaims | undefined): boolean {
  // A demo visitor signs in as a throwaway user; an address that happens to
  // match must still never reach the owner's tools.
  if (!auth || auth.demo === true) return false;
  const email = auth.email.trim().toLowerCase();
  return email.length > 0 && operatorEmails().has(email);
}

/** After `authenticate`: 403 for anyone who is not a platform operator. */
export function requirePlatformOperator(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!isPlatformOperator(req.auth)) {
    res.status(403).json({ error: 'Only the platform owner can review the shared catalog.' });
    return;
  }
  next();
}
