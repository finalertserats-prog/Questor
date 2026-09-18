import { Router, type Response } from 'express';
import { z } from 'zod';
import { prisma, parseJsonStrict } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { extractRole, extractRoleHeuristic } from '../engines/roleIntelligence.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import { roleSuccessProfileSchema } from '../domain/profileSchema.js';
import { logAudit } from '../services/audit.js';
import { assertCanAccessRole, assignRole, roleScope } from '../services/access.js';
import { ATS_EXTERNAL_ID } from '../providers/ats/index.js';
import { existingImport, lookupRequisition, type RequisitionLookup } from '../services/atsRecords.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { addCatalogRole, catalogTitleProblem } from '../services/catalogRoles.js';
import type { AuthClaims } from '../services/auth.js';
import { getRoleMetrics } from '../services/roleMetrics.js';
import { BANDS } from '../engines/experienceBands.js';

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
    include: { ...roleShapeInclude, scorecards: { orderBy: { version: 'desc' }, take: 1 }, _count: { select: { candidates: true } } },
  });
  res.json({ roles: roles.map((r) => ({
    id: r.id, title: r.title, level: r.level, status: r.status,
    latestScorecard: r.scorecards[0] ? { id: r.scorecards[0].id, version: r.scorecards[0].version, status: r.scorecards[0].status } : null,
    candidates: r._count.candidates, updatedAt: r.updatedAt, catalogRole: shapeCatalogRole(r.catalogRole), experienceBand: r.experienceBand, regionCode: r.regionCode, techStack: parseJsonStrict<string[]>(r.techStackJson, { model: 'Role', id: r.id, field: 'techStackJson' }),
  })) });
}));

const metricsQuerySchema = z.object({}).strict();

rolesRouter.get('/metrics', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  metricsQuerySchema.parse(req.query);
  res.json(await getRoleMetrics(req.auth!));
}));

const createSchema = z.object({
  sourceType: z.enum(['paste', 'file', 'ats', 'form']).default('paste'),
  // Sent straight to a paid model; a JD is a few thousand characters, and
  // fifty thousand is already a book chapter.
  sourceText: z.string().max(50_000).default(''),
  title: z.string().max(200)
    .refine((t) => [...t].every((ch) => (ch.codePointAt(0) ?? 0) >= 32 && ch.codePointAt(0) !== 127), 'A title is a single line.')
    .optional(),
  atsRequisitionId: z.string().regex(ATS_EXTERNAL_ID, 'An ATS requisition id is letters, numbers, dashes or underscores.').optional(),
  useLlm: z.boolean().default(true),
  catalogRoleId: z.string().cuid().optional(),
  // The catalog domain a new title belongs to. With no catalogRoleId, the
  // role's final title (typed, or inferred from the JD / requisition) is found
  // in or added to the shared catalog under this domain.
  domainId: z.string().cuid().optional(),
  experienceBand: z.enum(BANDS.map((b) => b.id) as [string, ...string[]]).optional(),
  regionCode: z.string().optional(),
  techStack: z.array(z.string().trim().min(1).max(40)).max(15).default([]),
});

// Create a role from JD / ATS + auto-extract a draft scorecard (FR-001..004)
// Every call may spend on the model. Per user: an office shares one address.
const roleCreateLimit = rateLimit({ name: 'role-create', windowMs: 15 * 60_000, max: 30, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

rolesRouter.post('/', requireCapability('role:create'), roleCreateLimit, asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const auth = req.auth!;
  let sourceText = body.sourceText;
  // Spaces are not a title: blank means "infer it from the JD or requisition".
  let titleHint = (body.title ?? '').trim();
  const catalogRole = body.catalogRoleId ? await prisma.catalogRole.findFirst({
    where: { id: body.catalogRoleId, status: 'active' },
    select: { id: true, title: true },
  }) : null;
  if (body.catalogRoleId && !catalogRole) throw new HttpError(400, 'Unknown or inactive catalog role.');
  if (catalogRole && !titleHint.trim()) titleHint = catalogRole.title;
  // Checked before extraction, which may spend on a paid model.
  if (!catalogRole && body.domainId) {
    const domain = await prisma.catalogDomain.findFirst({ where: { id: body.domainId, status: 'active' }, select: { id: true } });
    if (!domain) throw new HttpError(400, 'Unknown or inactive catalog domain.');
  }
  if (body.regionCode) {
    const region = await prisma.catalogRegion.findFirst({ where: { code: body.regionCode, status: 'active' }, select: { code: true } });
    if (!region) throw new HttpError(400, 'Unknown or inactive catalog region.');
  }

  // From the caller's own ATS only. This used to read any requisition id from
  // one deployment-wide ATS before any tenant check.
  let lookup: RequisitionLookup | null = null;
  if (body.sourceType === 'ats') {
    if (!body.atsRequisitionId) throw new HttpError(400, 'Enter the ATS requisition id to import.');
    lookup = await lookupRequisition(auth, body.atsRequisitionId);
    if (lookup.kind === 'existing') {
      await respondWithExistingRole(lookup.roleId, res);
      return;
    }
    sourceText = lookup.requisition.description || sourceText;
    titleHint = titleHint || lookup.requisition.title;
  }
  if (!sourceText.trim()) throw new HttpError(400, 'sourceText (or ATS requisition) is required');

  const extraction = body.useLlm ? await extractRole(sourceText, titleHint) : extractRoleHeuristic(sourceText, titleHint);
  const ats = lookup?.kind === 'new' ? lookup.ats : null;
  const catalogRoleId = catalogRole?.id ?? (body.domainId ? await linkCatalogRole(auth, body.domainId, extraction.title, body.techStack) : undefined);

  let created;
  try {
    // One transaction, so a requisition import that loses a race leaves no
    // stray role behind, and the creator is never without access to their role.
    created = await prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          tenantId: auth.tenantId, title: extraction.title, level: extraction.level,
          location: extraction.location, employmentType: extraction.employmentType,
          sourceType: body.sourceType, sourceText, status: 'draft', createdById: auth.userId,
          catalogRoleId, experienceBand: body.experienceBand, regionCode: body.regionCode, techStackJson: JSON.stringify(body.techStack),
        },
      });
      // With scoping in force an unassigned role is admin-only, so without this
      // the creator would immediately lose access to the role they just made.
      await assignRole(role.id, auth.userId, 'owner', tx);
      const scorecard = await tx.roleScorecardVersion.create({
        data: { roleId: role.id, version: 1, status: 'draft', profileJson: JSON.stringify(extraction.profile) },
      });
      if (ats && body.atsRequisitionId) {
        await tx.atsRequisitionImport.create({
          data: {
            tenantId: auth.tenantId, connectionId: ats.connection.id, atsKey: ats.connection.atsKey,
            externalRequisitionId: body.atsRequisitionId, roleId: role.id, createdById: auth.userId,
          },
        });
      }
      return { role, scorecard };
    });
  } catch (err) {
    if (!(ats && body.atsRequisitionId && (err as { code?: string } | null)?.code === 'P2002')) throw err;
    // A concurrent import of the same requisition won; answer with its role.
    const raced = await existingImport(auth, ats.connection.atsKey, body.atsRequisitionId);
    if (!raced || raced.kind !== 'existing') throw err;
    await respondWithExistingRole(raced.roleId, res);
    return;
  }
  const { role, scorecard } = created;
  const fullCreatedRole = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, include: roleShapeInclude });
  await logAudit({
    tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user', action: 'role.created', entityType: 'Role', entityId: role.id,
    after: { title: role.title, ...(ats ? { source: 'ats' } : {}) },
  });

  res.status(201).json({ role: shapeRole(fullCreatedRole), scorecard: shapeScorecard(scorecard), jdWarnings: extraction.jdWarnings });
}));

/**
 * The catalog role a new role's title belongs to: the existing active match, or
 * a new shared entry. A title the shared catalog must not hold (an email, a
 * link, a long number) or one the owner retired leaves the role unlinked
 * rather than refusing it — the organisation's own role is still valid.
 */
async function linkCatalogRole(auth: AuthClaims, domainId: string, title: string, techStack: readonly string[]): Promise<string | undefined> {
  if (catalogTitleProblem(title)) return undefined;
  const result = await addCatalogRole({ auth, domainId, title, techStack });
  if (result.kind === 'created') return result.id;
  return result.role.status === 'active' ? result.role.id : undefined;
}

/** A repeat import is not an error: it answers with the role the first one made. */
async function respondWithExistingRole(roleId: string, res: Response) {
  const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId }, include: roleShapeInclude });
  const latest = await prisma.roleScorecardVersion.findFirst({ where: { roleId }, orderBy: { version: 'desc' } });
  res.status(200).json({
    role: shapeRole(role),
    scorecard: latest ? shapeScorecard(latest) : null,
    jdWarnings: [],
    alreadyImported: true,
  });
}

// Get role + latest scorecard
rolesRouter.get('/:id', asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const fullRole = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, include: roleShapeInclude });
  const scorecards = await prisma.roleScorecardVersion.findMany({ where: { roleId: role.id }, orderBy: { version: 'desc' } });
  res.json({ role: shapeRole(fullRole), scorecards: scorecards.map(shapeScorecard) });
}));

// Bounded on purpose. This used to be `z.any()`, and one Save could store a
// threshold of 6500 or a weight of 40 into the JSON every engine reads.
const updateScorecardSchema = z.object({ profile: roleSuccessProfileSchema });

// Edit the draft scorecard (calibrate competencies/weights) — creates a new version if approved one exists
rolesRouter.put('/:id/scorecard', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const fullRole = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, include: roleShapeInclude });
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
  const fullRole = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, include: roleShapeInclude });
  const latest = await prisma.roleScorecardVersion.findFirst({ where: { roleId: role.id }, orderBy: { version: 'desc' } });
  if (!latest) throw new HttpError(404, 'No scorecard to approve');
  // Unreadable is not "no competencies": that message sends the author to edit
  // a scorecard whose editor would show them nothing to fix.
  const profile = parseJsonStrict<RoleSuccessProfile>(latest.profileJson, { model: 'RoleScorecardVersion', id: latest.id, field: 'profileJson' });
  if (!profile.competencies?.length) throw new HttpError(400, 'Scorecard has no competencies');
  // A scorecard stored before the edit schema existed can hold anything. The
  // approval is the gate that lets it drive interviews, so it is checked here
  // as strictly as a save would be.
  const valid = roleSuccessProfileSchema.safeParse(profile);
  if (!valid.success) {
    const first = valid.error.issues[0];
    throw new HttpError(400, `This scorecard cannot be approved until its scoring settings are fixed: ${first?.message ?? 'invalid scorecard'} Open it, correct it, save, and approve again.`);
  }

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
  const fullRole = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, include: roleShapeInclude });
  const extraction = extractRoleHeuristic(role.sourceText, role.title);
  res.json({ jdWarnings: extraction.jdWarnings });
}));

// The former `getRole(tenantId, id)` helper is gone rather than fixed in place:
// a tenant-only lookup that LOOKS like an access check is the more dangerous
// shape, because the next route added would reach for it and inherit the hole.
// `assertCanAccessRole` is the only way in, and it already answers 404 (not 403)
// so an out-of-scope id is never confirmed to exist.

const roleShapeInclude = { catalogRole: { include: { domain: true } } } as const;

type ShapedRole = {
  readonly id: string; readonly title: string; readonly level: string; readonly location: string; readonly employmentType: string;
  readonly status: string; readonly sourceType: string; readonly updatedAt: Date; readonly experienceBand: string | null;
  readonly regionCode: string | null; readonly techStackJson: string;
  readonly catalogRole: { readonly id: string; readonly title: string; readonly domain: { readonly id: string; readonly name: string } } | null;
};

function shapeCatalogRole(role: ShapedRole['catalogRole']) {
  return role ? { id: role.id, title: role.title, domain: { id: role.domain.id, name: role.domain.name } } : null;
}

function shapeRole(r: ShapedRole) {
  return { id: r.id, title: r.title, level: r.level, location: r.location, employmentType: r.employmentType, status: r.status, sourceType: r.sourceType, updatedAt: r.updatedAt, catalogRole: shapeCatalogRole(r.catalogRole), experienceBand: r.experienceBand, regionCode: r.regionCode, techStack: parseJsonStrict<string[]>(r.techStackJson, { model: 'Role', id: r.id, field: 'techStackJson' }) };
}
function shapeScorecard(s: { readonly id: string; readonly version: number; readonly status: string; readonly profileJson: string; readonly approvedAt: Date | null }) {
  return { id: s.id, version: s.version, status: s.status, profile: parseJsonStrict(s.profileJson, { model: 'RoleScorecardVersion', id: s.id, field: 'profileJson' }), approvedAt: s.approvedAt };
}
