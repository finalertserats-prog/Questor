import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../middleware/index.js';
import { answerOptInRequest, optInLinkState } from '../services/candidateFeedbackOptInRequest.js';

/**
 * "Would you like written feedback?" — the link a recruiter's request emails to
 * a candidate who was never asked.
 *
 * Unauthenticated for the same reason as the talk-to-a-person link: answering
 * must not require an account. The token is the whole access control, so
 * neither route returns anything about the person, and the answer is only
 * recorded on a POST — mail scanners fetch every link in a message, and a GET
 * that recorded would answer for candidates who never clicked.
 */
export const feedbackConsentRouter = Router();

feedbackConsentRouter.get('/:token', asyncHandler(async (req, res) => {
  res.json({ state: await optInLinkState(req.params.token) });
}));

const answerSchema = z.object({ wantsFeedback: z.boolean() }).strict();

feedbackConsentRouter.post('/:token/answer', asyncHandler(async (req, res) => {
  const body = answerSchema.parse(req.body);
  const { created } = await answerOptInRequest(req.params.token, body.wantsFeedback);
  // A replay learns that an answer exists, never which one: the page tells the
  // candidate their earlier answer stands.
  res.status(created ? 201 : 200).json({ state: created ? 'recorded' : 'answered' });
}));
