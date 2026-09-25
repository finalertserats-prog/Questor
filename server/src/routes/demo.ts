import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { prisma } from '../db.js';
import { invitationLink } from '../services/invitations.js';
import { clearSession } from '../services/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import { decideDemoAccess, expireDemoInterviewLinks, redeemDemoAccess, requestDemoAccess, requestDemoReaccess, resolveDemoDecision } from '../services/demoAccess.js';
import { demoStatus } from '../services/demoStatus.js';

export const demoRouter = Router();
export const demoDecisionRouter = Router();

// Name and company are mailed back as "Hi {name}" to whatever address was typed,
// so they must be plain single-line text: no links, no addresses, no line breaks.
const plainLine = (max: number) => z.string().trim().min(1).max(max)
  .refine((v) => [...v].every((ch) => (ch.codePointAt(0) ?? 0) >= 32 && ch.codePointAt(0) !== 127), 'Use a single line.')
  .refine((v) => !/@|:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|info|biz|xyz|ru|app|dev|link|example)\b/i.test(v), 'Links and email addresses are not allowed here.');
const requestSchema = z.object({ name: plainLine(80), email: z.string().email().max(254), company: plainLine(120) }).strict();
const tokenSchema = z.object({ token: z.string().min(24).max(128) }).strict();
const decisionSchema = z.object({ decision: z.enum(['approve', 'decline']) }).strict();

// Each new address builds a sandbox organisation and sends an email, so one
// network gets a handful per hour; the answer stays the same either way.
const demoRequestLimit = rateLimit({ name: 'demo-request', windowMs: 60 * 60_000, max: 5, keyOf: (req) => req.ip ?? 'unknown' });
const demoReaccessLimit = rateLimit({ name: 'demo-reaccess', windowMs: 60 * 60_000, max: 10, keyOf: (req) => req.ip ?? 'unknown' });

demoRouter.post('/request', demoRequestLimit, asyncHandler(async (req, res) => {
  const body = requestSchema.parse(req.body);
  // Always the same answer, so the form cannot be used to learn who has
  // asked before; a failure is logged for us instead of shown to them.
  await requestDemoAccess({ ...body, ip: req.ip ?? 'unknown' }).catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Demo request failed');
  });
  res.status(202).json({ status: 'accepted' });
}));

demoRouter.post('/redeem', asyncHandler(async (req, res) => {
  const { token } = tokenSchema.parse(req.body);
  try {
    res.json(await redeemDemoAccess(token, res));
  } catch (err) {
    if (err instanceof HttpError && err.status === 410) {
      res.status(410).json({ error: 'This demo link cannot be used.', code: err.code ?? 'unknown', reason: err.code ?? 'unknown', canRequestAgain: err.code === 'used' || err.code === 'expired' });
      return;
    }
    throw err;
  }
}));

// The candidate side of the sample interview, so the visitor can sit it
// themselves. Only for a signed-in demo, and only its own sandbox's interview.
demoRouter.get('/interview', authenticate, asyncHandler(async (req, res) => {
  if (req.auth?.demo !== true) throw new HttpError(403, 'Only available in a demo.');
  const session = await prisma.interviewSession.findFirst({
    where: { tenantId: req.auth.tenantId, invitation: { isNot: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, invitation: { select: { tokenSealed: true } } },
  });
  const portalUrl = session?.invitation ? invitationLink(session.invitation) : null;
  if (!session || !portalUrl) throw new HttpError(404, 'The sample interview is not available.');
  res.json({ interviewId: session.id, portalUrl });
}));

// What the guided tour needs about this sandbox: who is visiting, where the
// story's records are, the creation caps, and what the live parts run on.
demoRouter.get('/status', authenticate, asyncHandler(async (req, res) => {
  if (req.auth?.demo !== true || !req.auth.demoGrantId) throw new HttpError(403, 'Only available in a demo.');
  res.json(await demoStatus(req.auth));
}));

// "End demo" ends it here, not only in the browser: the session token stops
// working at once instead of at the 45-minute mark.
demoRouter.post('/end', authenticate, asyncHandler(async (req, res) => {
  if (req.auth?.demo !== true || !req.auth.demoGrantId) throw new HttpError(403, 'Only available in a demo.');
  const endedAt = new Date();
  await prisma.demoGrant.updateMany({ where: { id: req.auth.demoGrantId }, data: { sessionEndsAt: endedAt } });
  await expireDemoInterviewLinks(req.auth.tenantId, endedAt);
  clearSession(res);
  res.json({ ended: true });
}));

demoRouter.post('/reaccess', demoReaccessLimit, asyncHandler(async (req, res) => {
  const { token } = tokenSchema.parse(req.body);
  await requestDemoReaccess({ token });
  res.status(202).json({ status: 'accepted' });
}));

demoDecisionRouter.get('/:token', asyncHandler(async (req, res) => {
  const row = await resolveDemoDecision(req.params.token);
  res.json({ state: row.status === 'reaccess_requested' ? 'open' : 'decided', applicant: { name: row.name, email: row.email, organisation: row.company, mode: 'demo' } });
}));

demoDecisionRouter.post('/:token', asyncHandler(async (req, res) => {
  const { decision } = decisionSchema.parse(req.body);
  const transitioned = await decideDemoAccess({ token: req.params.token, decision });
  if (!transitioned) throw new HttpError(409, 'This request has already been decided.');
  res.json({ recorded: true });
}));
