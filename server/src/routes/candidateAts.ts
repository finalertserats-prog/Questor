import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { ATS_EXTERNAL_ID } from '../providers/ats/index.js';
import { assertCanAccessCandidate } from '../services/access.js';
import { findConnection, tenantAtsReady } from '../services/atsConnections.js';
import { findCandidateLink, importCandidate, removeCandidateLink, setCandidateLink, shapeLink } from '../services/atsRecords.js';

// A candidate's place in the organisation's ATS: import from it, and the link
// an export writes to. Mounted on /api/candidates beside the main router.

export const candidateAtsRouter = Router();
candidateAtsRouter.use(authenticate);

const externalId = z.string().trim().regex(ATS_EXTERNAL_ID, 'An ATS candidate id is letters, numbers, dashes or underscores.');

// Every call here reaches the organisation's ATS.
const atsLookupLimit = rateLimit({ name: 'ats-candidate', windowMs: 15 * 60_000, max: 60, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

const importSchema = z.object({ externalCandidateId: externalId, roleId: z.string().min(1).max(64) }).strict();

candidateAtsRouter.post('/import-ats', requireCapability('candidate:create'), atsLookupLimit, asyncHandler(async (req, res) => {
  const body = importSchema.parse(req.body);
  const { candidate, created, matchedBy } = await importCandidate({ auth: req.auth!, ...body, requestId: req.requestId });
  res.status(created ? 201 : 200).json({
    candidate: { id: candidate.id, fullName: candidate.fullName, email: candidate.email, roleId: candidate.roleId },
    alreadyImported: !created,
    ...(matchedBy ? { matchedBy } : {}),
  });
}));

// Reading and setting the link are admin actions: the link decides where this
// candidate's assessments are written in the system of record.
candidateAtsRouter.get('/:id/ats-link', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  await assertCanAccessCandidate(req.auth!, req.params.id);
  const connection = await findConnection(req.auth!.tenantId);
  const link = connection ? await findCandidateLink(req.auth!.tenantId, req.params.id, connection.id) : null;
  res.json({ connected: await tenantAtsReady(req.auth!.tenantId), link: link ? shapeLink(link) : null });
}));

const linkSchema = z.object({ externalCandidateId: externalId }).strict();

candidateAtsRouter.put('/:id/ats-link', requireCapability('admin:manage'), atsLookupLimit, asyncHandler(async (req, res) => {
  const body = linkSchema.parse(req.body);
  const link = await setCandidateLink({ auth: req.auth!, candidateId: req.params.id, externalCandidateId: body.externalCandidateId, requestId: req.requestId });
  res.json({ link: shapeLink(link) });
}));

candidateAtsRouter.delete('/:id/ats-link', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const removed = await removeCandidateLink({ auth: req.auth!, candidateId: req.params.id, requestId: req.requestId });
  res.json({ removed });
}));
