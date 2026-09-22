import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, requireCapability, HttpError } from '../middleware/index.js';
import { assertCanAccessCandidate, assertCanAccessRole } from '../services/access.js';
import {
  MAX_SHORTLIST,
  listRoleCandidates,
  roleCandidatesQuerySchema,
  shortlistedIds,
} from '../services/roleCandidates.js';
import { comparisonQuerySchema, compareCandidates, roleCompetencyGrid } from '../services/roleComparison.js';

/**
 * /api/roles/:id/candidates — this role's applicants, side by side.
 *
 * Every route here asks for `candidate:read` on top of the role's own scope:
 * a requisition someone may open is not the same as the people in it, and an
 * auditor holds neither. The role is checked first (`assertCanAccessRole`),
 * which answers 404 rather than 403, so an id out of scope is never confirmed
 * to exist.
 */
export const roleCandidatesRouter = Router({ mergeParams: true });

const roleId = (req: { params: Record<string, string> }) => req.params.id;

// The table: one row per applicant, ordered by the key the caller asked for.
roleCandidatesRouter.get('/', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const query = roleCandidatesQuerySchema.parse(req.query);
  const role = await assertCanAccessRole(req.auth!, roleId(req));
  res.json(await listRoleCandidates(req.auth!, role.id, query));
}));

// The skills grid: the same rows, as levels against the role's competencies.
roleCandidatesRouter.get('/grid', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const query = roleCandidatesQuerySchema.parse(req.query);
  const role = await assertCanAccessRole(req.auth!, roleId(req));
  res.json(await roleCompetencyGrid(req.auth!, role.id, query));
}));

// Two to four candidates, read against each other.
roleCandidatesRouter.get('/comparison', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const { ids } = comparisonQuerySchema.parse(req.query);
  const role = await assertCanAccessRole(req.auth!, roleId(req));
  res.json(await compareCandidates(req.auth!, role.id, ids));
}));

/**
 * The shortlist: per role AND per user.
 *
 * A shortlist is a working set, not a decision — decisions are recorded on the
 * pipeline in the one verdict vocabulary. Keeping it personal means one
 * reviewer's reading of a candidate cannot reach another before they have
 * formed their own, which is the anchoring the blind-review policy exists to
 * prevent, and it keeps the list free of ids the next viewer's object scope
 * would have to silently drop.
 */
export const roleShortlistRouter = Router({ mergeParams: true });

roleShortlistRouter.get('/', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, roleId(req));
  res.json({ candidateIds: [...await shortlistedIds(req.auth!, role.id)], max: MAX_SHORTLIST });
}));

const shortlistBody = z.object({ candidateId: z.string().min(1).max(64) }).strict();

roleShortlistRouter.post('/', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const { candidateId } = shortlistBody.parse(req.body ?? {});
  const role = await assertCanAccessRole(req.auth!, roleId(req));
  // Object scope on the candidate too: the role being visible says nothing
  // about this person, and a tick is a read of their row on every later page.
  const candidate = await assertCanAccessCandidate(req.auth!, candidateId);
  if (candidate.roleId !== role.id) throw new HttpError(404, 'Candidate not found');

  // Written first, counted after, inside one transaction: a check that runs
  // before the write is a check two clicks can both pass. Ticking someone
  // already ticked adds nothing, so it can never push a full list over.
  // The side-by-side counts the ids it is given independently, so even a list
  // that somehow grew past the ceiling cannot produce an unreadable comparison.
  await prisma.$transaction(async (tx) => {
    await tx.candidateShortlist.upsert({
      where: { roleId_userId_candidateId: { roleId: role.id, userId: req.auth!.userId, candidateId } },
      create: { tenantId: req.auth!.tenantId, roleId: role.id, userId: req.auth!.userId, candidateId },
      update: {},
    });
    const held = await tx.candidateShortlist.count({ where: { roleId: role.id, userId: req.auth!.userId, tenantId: req.auth!.tenantId } });
    if (held > MAX_SHORTLIST) {
      throw new HttpError(
        409,
        `A shortlist holds up to ${MAX_SHORTLIST} candidates — more than that cannot be read side by side. Untick someone first.`,
        'shortlist_full',
      );
    }
  });
  res.status(201).json({ candidateIds: [...await shortlistedIds(req.auth!, role.id)], max: MAX_SHORTLIST });
}));

roleShortlistRouter.delete('/:candidateId', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const { candidateId } = z.object({ candidateId: z.string().min(1).max(64) }).parse(req.params);
  const role = await assertCanAccessRole(req.auth!, roleId(req));
  // deleteMany, keyed by this user: an untick can only ever remove their own
  // row, and removing one that is not there is not an error.
  await prisma.candidateShortlist.deleteMany({
    where: { roleId: role.id, userId: req.auth!.userId, tenantId: req.auth!.tenantId, candidateId },
  });
  res.json({ candidateIds: [...await shortlistedIds(req.auth!, role.id)], max: MAX_SHORTLIST });
}));
