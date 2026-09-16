import { Router } from 'express';
import { asyncHandler } from '../middleware/index.js';
import { recordHumanRequest, resolveHumanRequest } from '../services/candidateFeedback.js';
import { emitEvent } from '../services/webhooks.js';
import { logger } from '../logger.js';

/**
 * "Would you like to speak to a person?" — the one thing the link in a feedback
 * email can do.
 *
 * Unauthenticated, because requiring a candidate to create an account in order
 * to ask for a conversation would be its own answer. The token is the whole of
 * the access control, so this router is written to be worth as little as
 * possible to anyone holding a stolen one:
 *
 *   - It exposes exactly two operations, neither of which reads candidate data.
 *   - GET answers one question — is this link still good? — with a single
 *     enumerated string. No name, no role, no email, no identifiers.
 *   - The recording step is a POST. A GET that mutates would be triggered by
 *     every link-scanning mail gateway on the way in, and HR would ring
 *     candidates who never asked for a call.
 */
export const feedbackRequestRouter = Router();

/**
 * Is this link still usable? Returned to the confirmation page so it can show
 * the button, the "already done" message or the expiry notice — without ever
 * learning who the link belongs to.
 */
feedbackRequestRouter.get('/:token', asyncHandler(async (req, res) => {
  const row = await resolveHumanRequest(req.params.token);
  res.json({ state: row.status === 'REQUESTED' ? 'recorded' : 'open' });
}));

feedbackRequestRouter.post('/:token/confirm', asyncHandler(async (req, res) => {
  // The claimed row comes back from the write itself. Re-reading through the
  // token after the mutation meant a link expiring in that gap could record the
  // request and then throw 410 at the candidate who had just made it.
  const claimed = await recordHumanRequest(req.params.token);
  // Only the first click notifies. A double-click, or a client that retries,
  // must not put the same candidate in front of the hiring team twice.
  if (claimed) {
    // A webhook subscriber must not be able to fail a candidate's request by
    // being down.
    await emitEvent(claimed.tenantId, 'candidate.human_request', {
      candidateId: claimed.candidateId,
      sessionId: claimed.sessionId,
      requestedAt: claimed.requestedAt,
    }).catch((err) => logger.warn(
      { err, sessionId: claimed.sessionId },
      'candidate.human_request webhook failed to emit; the request is recorded and visible to the hiring team in the app, but no webhook was delivered and a later click will not retry it',
    ));
  }
  // Same body whether this was the first click or the fifth. The candidate gets
  // a consistent answer, and the response reveals nothing about prior activity.
  res.json({ recorded: true });
}));
