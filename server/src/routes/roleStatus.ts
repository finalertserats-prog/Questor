import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { assertCanAccessRole } from '../services/access.js';
import { logAudit } from '../services/audit.js';

/**
 * Archive and restore a role. Nothing else: draft -> approved goes through
 * scorecard approval (POST /api/roles/:id/approve), and a restored role returns
 * to the state its latest scorecard implies — approved only if that scorecard
 * was approved — whatever the request asked for, so this can never be used to
 * skip the approval gate.
 *
 * Gated like approval: archiving closes a requisition, which is the hiring
 * manager's call rather than the recruiter's.
 */
export const roleStatusRouter = Router();

const statusSchema = z.object({ status: z.enum(['archived', 'draft', 'approved']) }).strict();

roleStatusRouter.patch('/:id/status', authenticate, requireCapability('role:approve_scorecard'), asyncHandler(async (req, res) => {
  const { status: requested } = statusSchema.parse(req.body);
  const role = await assertCanAccessRole(req.auth!, req.params.id);

  let next: string;
  if (requested === 'archived') {
    next = 'archived';
  } else {
    if (role.status !== 'archived') throw new HttpError(409, 'Only an archived role can be restored here. Approve its scorecard to make it approved.');
    const latest = await prisma.roleScorecardVersion.findFirst({ where: { roleId: role.id }, orderBy: { version: 'desc' }, select: { status: true } });
    next = latest?.status === 'approved' ? 'approved' : 'draft';
  }

  if (next !== role.status) {
    // Conditional on the status just read, so two concurrent changes cannot
    // both be recorded against the same starting state.
    const changed = await prisma.role.updateMany({ where: { id: role.id, tenantId: req.auth!.tenantId, status: role.status }, data: { status: next } });
    if (changed.count !== 1) throw new HttpError(409, 'This role was changed at the same time. Reload and try again.');
    await logAudit({
      tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
      action: next === 'archived' ? 'role.archived' : 'role.unarchived', entityType: 'Role', entityId: role.id,
      before: { status: role.status }, after: { status: next },
    });
  }
  res.json({ role: { id: role.id, status: next }, previousStatus: role.status });
}));
