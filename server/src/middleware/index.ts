import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { nanoid } from 'nanoid';
import { verifyToken, type AuthClaims } from '../services/auth.js';
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
  // Header only. Accepting a token from the query string leaked valid sessions
  // into access logs, proxy logs, browser history and Referer headers — on a
  // shared machine, browser history alone handed over a live session.
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) return res.status(401).json({ error: 'Missing authentication token' });
  const claims = verifyToken(token);
  if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
  req.auth = claims;
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
