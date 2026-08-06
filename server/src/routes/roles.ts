import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { extractRole, extractRoleHeuristic } from '../engines/roleIntelligence.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import { logAudit } from '../services/audit.js';
import { assertCanAccessRole, assignRole, roleScope } from '../services/access.js';
import { getAts } from '../providers/ats/index.js';

export const rolesRouter = Router();
rolesRouter.use(authenticate);

// List roles
//
// Scoped to the requisitions this user is actually assigned, not to the whole
// tenant. A tenant-wide list here is a disclosure in itself: requisition titles
// and headcount leak reorganisations and unannounced hiring before they are public.
rolesRouter.get('/', asyncHandler(async (req, res) => {
  const roles = await prisma.role.findMany({
    where: await roleScope(req.auth!),
    orderBy: { updatedAt: 'desc' },
    include: { scorecards: { orderBy: { version: 'desc' }, take: 1 }, _count: { select: { candidates: true } } },
  });
  res.json({ roles: roles.map((r) => ({
    id: r.id, title: r.title, level: r.level, status: r.status,
    latestScorecard: r.scorecards[0] ? { id: r.scorecards[0].id, version: r.scorecards[0].version, status: r.scorecards[0].status } : null,
    candidates: r._count.candidates, updatedAt: r.updatedAt,
  })) });
}));

const createSchema = z.object({
  sourceType: z.enum(['paste', 'file', 'ats', 'form']).default('paste'),
  sourceText: z.string().default(''),
  title: z.string().optional(),
  atsRequisitionId: z.string().optional(),
  useLlm: z.boolean().default(true),
});

// Create a role from JD / ATS + auto-extract a draft scorecard (FR-001..004)
rolesRouter.post('/', requireCapability('role:create'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  let sourceText = body.sourceText;
  let titleHint = body.title ?? '';

  if (body.sourceType === 'ats' && body.atsRequisitionId) {
    const req0 = await getAts().fetchRequisition(body.atsRequisitionId);
    sourceText = req0.description || sourceText;
    titleHint = titleHint || req0.title;
  }
  if (!sourceText.trim()) throw new HttpError(400, 'sourceText (or ATS requisition) is required');

  const extraction = body.useLlm ? await extractRole(sourceText, titleHint) : extractRoleHeuristic(sourceText, titleHint);

  const role = await prisma.role.create({
    data: {
      tenantId: req.auth!.tenantId, title: extraction.title, level: extraction.level,
      location: extraction.location, employmentType: extraction.employmentType,
      sourceType: body.sourceType, sourceText, status: 'draft', createdById: req.auth!.userId,
    },
  });
  // Before the next query runs: with scoping in force an unassigned role is
  // admin-only, so without this the creator would immediately lose access to
  // the role they just made — including the scorecard step below.
  await assignRole(role.id, req.auth!.userId, 'owner');

  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: 1, status: 'draft', profileJson: JSON.stringify(extraction.profile) },
  });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'role.created', entityType: 'Role', entityId: role.id, after: { title: role.title } });

  res.status(201).json({ role: shapeRole(role), scorecard: shapeScorecard(scorecard), jdWarnings: extraction.jdWarnings });
}));

// Get role + latest scorecard
rolesRouter.get('/:id', asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const scorecards = await prisma.roleScorecardVersion.findMany({ where: { roleId: role.id }, orderBy: { version: 'desc' } });
  res.json({ role: shapeRole(role), scorecards: scorecards.map(shapeScorecard) });
}));

const updateScorecardSchema = z.object({ profile: z.any() });

// Edit the draft scorecard (calibrate competencies/weights) — creates a new version if approved one exists
rolesRouter.put('/:id/scorecard', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const { profile } = updateScorecardSchema.parse(req.body);
  const latest = await prisma.roleScorecardVersion.findFirst({ where: { roleId: role.id }, orderBy: { version: 'desc' } });
  if (!latest) throw new HttpError(404, 'No scorecard to update');

  let target = latest;
  if (latest.status === 'approved') {
    target = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: latest.version + 1, status: 'draft', profileJson: JSON.stringify(profile) } });
  } else {
    target = await prisma.roleScorecardVersion.update({ where: { id: latest.id }, data: { profileJson: JSON.stringify(profile) } });
  }
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'role.scorecard.updated', entityType: 'RoleScorecardVersion', entityId: target.id });
  res.json({ scorecard: shapeScorecard(target) });
}));

// Approve scorecard (FR-003: no scoring until approved)
//
// Recruiters hold `role:edit_scorecard` but deliberately NOT
// `role:approve_scorecard`: the author of a scorecard approving it themselves is
// the separation-of-duties gap this gate exists to close.
rolesRouter.post('/:id/approve', requireCapability('role:approve_scorecard'), asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const latest = await prisma.roleScorecardVersion.findFirst({ where: { roleId: role.id }, orderBy: { version: 'desc' } });
  if (!latest) throw new HttpError(404, 'No scorecard to approve');
  const profile = parseJson<RoleSuccessProfile>(latest.profileJson, {} as RoleSuccessProfile);
  if (!profile.competencies?.length) throw new HttpError(400, 'Scorecard has no competencies');

  const approved = await prisma.roleScorecardVersion.update({
    where: { id: latest.id }, data: { status: 'approved', approvedById: req.auth!.userId, approvedAt: new Date() },
  });
  await prisma.role.update({ where: { id: role.id }, data: { status: 'approved' } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'role.approved', entityType: 'RoleScorecardVersion', entityId: approved.id });
  res.json({ scorecard: shapeScorecard(approved) });
}));

// Validate: JD language warnings without mutating the role (FR-005)
rolesRouter.get('/:id/validate', asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const extraction = extractRoleHeuristic(role.sourceText, role.title);
  res.json({ jdWarnings: extraction.jdWarnings });
}));

// The former `getRole(tenantId, id)` helper is gone rather than fixed in place:
// a tenant-only lookup that LOOKS like an access check is the more dangerous
// shape, because the next route added would reach for it and inherit the hole.
// `assertCanAccessRole` is the only way in, and it already answers 404 (not 403)
// so an out-of-scope id is never confirmed to exist.

function shapeRole(r: any) {
  return { id: r.id, title: r.title, level: r.level, location: r.location, employmentType: r.employmentType, status: r.status, sourceType: r.sourceType, updatedAt: r.updatedAt };
}
function shapeScorecard(s: any) {
  return { id: s.id, version: s.version, status: s.status, profile: parseJson(s.profileJson, {}), approvedAt: s.approvedAt };
}
