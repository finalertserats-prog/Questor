import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { assertCanAccessCandidate } from '../services/access.js';
import { logAudit } from '../services/audit.js';
import { assignSme, findAssignableSme, listAssignedSmes, listSmes, unassignSme } from '../services/smeAccess.js';
import { smeReviewsForCandidate } from '../services/smeReview.js';
import { SME_ADVISORY_NOTE } from '../domain/smeRecommendation.js';

/**
 * /api/candidates/:id/sme — the hiring team's side of the expert review.
 *
 * Who is assessing this candidate, what they recommended, and the ability to
 * ask someone else. Gated on the hiring team's own capabilities, never on the
 * SME's: `sme:assigned_read` and `sme:review` belong to the expert's surface
 * alone, and an expert holds neither of the two used here.
 *
 * Reading is `assessment:read` rather than a capability of its own. Whoever may
 * read what the machine concluded about a candidate may read what a person
 * concluded about them — withholding the second from a reviewer who can see the
 * first would mean a human review written in ignorance of the expert advice it
 * was meant to weigh.
 *
 * Assigning is `sme:assign`, which a `reviewer` deliberately does not hold:
 * choosing who assesses a candidate is running the process, and that role
 * exists to be the second opinion on its output rather than a participant in
 * it.
 */
export const candidateSmeRouter = Router();
candidateSmeRouter.use(authenticate);

/**
 * GET /api/candidates/:id/sme — the experts on this candidate and what they said.
 *
 * `assertCanAccessCandidate` first, so an id outside the caller's scope answers
 * 404 and is never confirmed to exist.
 */
candidateSmeRouter.get('/:id/sme', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const candidate = await assertCanAccessCandidate(req.auth!, req.params.id);
  const [assigned, reviews] = await Promise.all([
    listAssignedSmes(candidate.id),
    smeReviewsForCandidate(req.auth!.tenantId, candidate.id),
  ]);
  res.json({
    assigned,
    reviews,
    // Awaiting an answer from someone who has been asked. Separated here rather
    // than left for the page to work out, so every surface that shows this says
    // "asked, nothing back yet" the same way — an expert who has not replied
    // and an expert who has nothing to say look identical otherwise.
    awaiting: assigned.filter((sme) => !reviews.some((review) => review.sme.id === sme.userId)),
    note: SME_ADVISORY_NOTE,
  });
}));

/** GET /api/candidates/:id/sme/available — the experts in this organisation who could be asked. */
candidateSmeRouter.get('/:id/sme/available', requireCapability('sme:assign'), asyncHandler(async (req, res) => {
  await assertCanAccessCandidate(req.auth!, req.params.id);
  res.json({ smes: await listSmes(req.auth!.tenantId) });
}));

const assignSchema = z.object({ userId: z.string().min(1) });

/**
 * POST /api/candidates/:id/sme — ask an expert to assess this candidate.
 *
 * Two checks, in this order: the caller may reach the candidate, and the person
 * they named is an SME in the same organisation. The second is what stops this
 * becoming a general-purpose grant — `CandidateAssignment` is also what
 * `candidateScope` reads, so assigning an auditor here would hand candidate
 * detail to the one role defined by not having it.
 */
candidateSmeRouter.post('/:id/sme', requireCapability('sme:assign'), asyncHandler(async (req, res) => {
  const { userId } = assignSchema.parse(req.body);
  const candidate = await assertCanAccessCandidate(req.auth!, req.params.id);
  const sme = await findAssignableSme(req.auth!.tenantId, userId);

  await assignSme(candidate.id, sme.id);
  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'sme.assigned', entityType: 'Candidate', entityId: candidate.id, requestId: req.requestId,
    after: { smeUserId: sme.id },
  });

  res.status(201).json({
    assigned: await listAssignedSmes(candidate.id),
    message: `${sme.name} can now see this candidate and record a recommendation.`,
  });
}));

/**
 * DELETE /api/candidates/:id/sme/:userId — stop asking.
 *
 * The expert loses access from their next request. Any recommendation they
 * already wrote stays: it happened, the team may have weighed it, and removing
 * it would be rewriting the record of a decision rather than withdrawing a
 * permission.
 */
candidateSmeRouter.delete('/:id/sme/:userId', requireCapability('sme:assign'), asyncHandler(async (req, res) => {
  const candidate = await assertCanAccessCandidate(req.auth!, req.params.id);
  const removed = await unassignSme(candidate.id, req.params.userId);
  if (removed > 0) {
    await logAudit({
      tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'sme.unassigned', entityType: 'Candidate', entityId: candidate.id, requestId: req.requestId,
      before: { smeUserId: req.params.userId },
    });
  }
  res.json({
    assigned: await listAssignedSmes(candidate.id),
    // True whether or not there was a row to remove, and said the same way
    // either way: the caller asked for this person not to have access, and
    // after this they do not.
    message: 'They can no longer see this candidate. Anything they already recorded is kept.',
  });
}));
