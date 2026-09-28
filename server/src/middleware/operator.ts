import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import type { AuthClaims } from '../services/auth.js';
import { HttpError } from './index.js';

/**
 * The deployment operator: whoever the signup decision emails go to. Some
 * actions are about the whole deployment (the signup queue, the shared meeting
 * vendor apps) and `admin:manage` alone would hand them to the admin of every
 * customer. With no approver configured nobody is the operator, so these
 * actions fail closed.
 */
export function isOperator(auth: Pick<AuthClaims, 'email'> | undefined): boolean {
  const approver = config.signupApproverEmail.trim().toLowerCase();
  if (!approver) return false;
  return (auth?.email ?? '').trim().toLowerCase() === approver;
}

interface OperatorMessages {
  /** The caller is signed in but is not the operator. */
  readonly forbidden: string;
  /** No operator is configured on this deployment. */
  readonly unconfigured: string;
  readonly unconfiguredStatus?: number;
}

/** Route guard for operator-only actions; mount after `requireCapability`. */
export function requireOperator(messages: OperatorMessages) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!config.signupApproverEmail.trim()) {
      return next(new HttpError(messages.unconfiguredStatus ?? 503, messages.unconfigured));
    }
    if (!isOperator(req.auth)) return next(new HttpError(403, messages.forbidden));
    return next();
  };
}
