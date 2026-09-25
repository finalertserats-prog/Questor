import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
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

/**
 * Every address this deployment grants standing to, whichever setting names
 * it. PLATFORM_OPERATOR_EMAILS reaches the shared catalog;
 * SIGNUP_APPROVER_EMAIL reaches the signup queue — which holds applicants
 * from every organisation — and the operations view.
 *
 * Two settings, two different powers, and they are deliberately not merged
 * anywhere else: the approver does not become a catalog owner by being the
 * approver. But both confer something no tenant may have, so both have to be
 * unclaimable, and reserving only one is the same as reserving neither.
 */
function reservedEmails(): ReadonlySet<string> {
  const reserved = new Set(operatorEmails());
  const approver = config.signupApproverEmail.trim().toLowerCase();
  if (approver.length > 0) reserved.add(approver);
  return reserved;
}

/**
 * Whether an address belongs to the platform owner. Operator standing is
 * keyed on the address, so whoever creates the account for it becomes the
 * owner: no tenant admin, applicant or self-registration may create one.
 *
 * This once checked PLATFORM_OPERATOR_EMAILS alone, while `isOperator` in
 * `operator.ts` conferred deployment-wide powers from SIGNUP_APPROVER_EMAIL.
 * An approver address with no account was therefore an open door: any tenant
 * admin could create it inside their own organisation, sign in, and read the
 * signup queue for every other one. Found unclaimed on the live deployment.
 */
export function isReservedOperatorEmail(email: string): boolean {
  return reservedEmails().has(email.trim().toLowerCase());
}

/**
 * At start-up: an operator address with no account is an open door until the
 * owner claims it (and the owner cannot sign in). Logged loudly, per address.
 */
export async function reportMissingOperatorAccounts(): Promise<void> {
  // Every reserved address, not just the catalog owner's: the approver's was
  // the one actually found unclaimed in production, and a warning that could
  // not name it is why nobody knew.
  const wanted = [...reservedEmails()];
  if (wanted.length === 0) return;
  const users = await prisma.user.findMany({ select: { email: true } });
  const present = new Set(users.map((u) => u.email.trim().toLowerCase()));
  for (const email of wanted.filter((e) => !present.has(e))) {
    logger.error({ email }, 'A reserved operator address (PLATFORM_OPERATOR_EMAILS or SIGNUP_APPROVER_EMAIL) has no account; create it from an existing operator session or remove it');
  }
}
