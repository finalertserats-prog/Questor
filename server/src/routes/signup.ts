import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { createSignupRequest, decideSignupRequest, resolveSignupDecision, signupApplicant } from '../services/signup.js';

export const signupRouter = Router();
export const signupDecisionRouter = Router();

const signupSchema = z.discriminatedUnion('mode', [
  z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    password: z.string().min(12, 'Password must be at least 12 characters'),
    mode: z.literal('new-org'),
    organisationName: z.string().min(1).max(200),
    orgCode: z.string().optional(),
  }).strict(),
  z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    password: z.string().min(12, 'Password must be at least 12 characters'),
    mode: z.literal('join'),
    orgCode: z.string().min(1).max(64),
    organisationName: z.string().optional(),
  }).strict(),
]);

const decisionSchema = z.object({ decision: z.enum(['approve', 'decline']) }).strict();

signupRouter.post('/', asyncHandler(async (req, res) => {
  const body = signupSchema.parse(req.body);
  await createSignupRequest(body);
  res.status(201).json({ status: 'pending' });
}));

signupDecisionRouter.get('/:token', asyncHandler(async (req, res) => {
  const row = await resolveSignupDecision(req.params.token);
  res.json({ state: row.status === 'PENDING' ? 'open' : 'decided', applicant: signupApplicant(row) });
}));

signupDecisionRouter.post('/:token', asyncHandler(async (req, res) => {
  const { decision } = decisionSchema.parse(req.body);
  const { transitioned } = await decideSignupRequest({ token: req.params.token, decision, actorId: 'signup-link' });
  // Reporting success for a decision nobody made is how a stale tab, a second
  // click, or a race with another admin all look like they worked.
  if (!transitioned) throw new HttpError(409, 'This request has already been decided.');
  res.json({ recorded: true });
}));
