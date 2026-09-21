import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJsonOptional } from '../db.js';
import { asyncHandler, requireCapability, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { competencySchema } from '../domain/profileSchema.js';
import {
  ScorecardEditError, addCompetency, cleanCompetencyText, removeCompetency, retireCompetency, scorecardWarnings, updateCompetency,
  type CompetencyInput,
} from '../domain/scorecardEdits.js';
import type { Competency, RoleSuccessProfile } from '../domain/types.js';
import { draftCompetency } from '../engines/competencyDraft.js';
import { logAudit } from '../services/audit.js';
import { assertCanAccessRole } from '../services/access.js';
import { assertRoleOpen } from '../services/roleOpen.js';
import { competencyIdsWithHistory } from '../services/competencyHistory.js';
import { latestScorecard, profileOf, writeScorecardProfile, type ScorecardRow } from '../services/scorecardVersions.js';
import type { AuthClaims } from '../services/auth.js';
import { roleBand, roleTechStack } from '../services/roleTechStack.js';

/**
 * /api/roles/:id/scorecard/competencies — one competency at a time.
 *
 * The whole-profile PUT beside this still works; these exist so that adding,
 * renaming or removing one competency is a single audited step with the weight
 * arithmetic done here rather than trusted from the page.
 */
export const roleCompetenciesRouter = Router({ mergeParams: true });

const fields = competencySchema.pick({ definition: true, category: true, classification: true, indicators: true }).extend({
  requiredLevel: competencySchema.shape.requiredLevel.optional(),
  targetLevel: competencySchema.shape.targetLevel.optional(),
});
const name = z.string().trim().min(1).max(120);
const weight = z.number().min(0).max(1);

const addSchema = z.union([
  fields.extend({ name, weight: weight.optional(), mustPass: z.boolean().optional() }).strict(),
  // From the organisation library: the entry supplies name, definition, category and indicators.
  z.object({ libraryId: z.string().cuid(), classification: fields.shape.classification, weight: weight.optional(), mustPass: z.boolean().optional() }).strict(),
]);

const patchSchema = fields.partial().extend({ name: name.optional(), weight: weight.optional(), mustPass: z.boolean().optional() }).strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change.');

const draftSchema = z.object({ name }).strict();

const competencyIdParam = z.string().trim().min(1).max(64);

// Drafting spends on a model; per user, like role creation.
const draftLimit = rateLimit({ name: 'competency-draft', windowMs: 15 * 60_000, max: 60, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

/** A ScorecardEditError as the HTTP refusal it describes. */
function asHttp(err: unknown): never {
  if (err instanceof ScorecardEditError) {
    const status = err.code === 'unknown_competency' ? 404 : err.code === 'duplicate_name' || err.code === 'duplicate_id' ? 409 : 400;
    throw new HttpError(status, err.message, err.code);
  }
  throw err;
}

interface Edited {
  readonly role: { readonly id: string; readonly tenantId: string };
  readonly before: ScorecardRow;
  readonly profile: RoleSuccessProfile;
}

async function openForEdit(auth: AuthClaims, roleId: string): Promise<Edited> {
  const role = await assertCanAccessRole(auth, roleId);
  await assertRoleOpen(role.id);
  const before = await latestScorecard(role.id);
  return { role, before, profile: profileOf(before) };
}

function shape(s: ScorecardRow, profile: RoleSuccessProfile) {
  return { id: s.id, version: s.version, status: s.status, profile, approvedAt: s.approvedAt, warnings: scorecardWarnings(profile) };
}

const summary = (c: Competency | undefined) => (c ? { id: c.id, name: c.name, weight: c.weight, classification: c.classification } : undefined);

async function libraryInput(tenantId: string, libraryId: string, rest: { classification: Competency['classification']; weight?: number; mustPass?: boolean }): Promise<CompetencyInput> {
  const entry = await prisma.orgCompetency.findFirst({ where: { id: libraryId, tenantId } });
  if (!entry) throw new HttpError(404, 'That library competency was not found.');
  const category = fields.shape.category.safeParse(entry.category);
  return {
    name: entry.name,
    definition: entry.definition,
    category: category.success ? category.data : 'domain',
    indicators: parseJsonOptional<string[]>(entry.indicatorsJson, [], { model: 'OrgCompetency', id: entry.id, field: 'indicatorsJson' }),
    ...rest,
  };
}

/** Keep the organisation's library current with what its people write. */
async function rememberInLibrary(tenantId: string, userId: string, c: Competency): Promise<void> {
  const nameKey = cleanCompetencyText(c.name).toLowerCase();
  const data = { name: c.name, category: c.category, definition: c.definition, indicatorsJson: JSON.stringify(c.indicators) };
  await prisma.orgCompetency.upsert({
    where: { tenantId_nameKey: { tenantId, nameKey } },
    create: { tenantId, nameKey, createdBy: userId, ...data },
    update: data,
  });
}

roleCompetenciesRouter.get('/library', requireCapability('role:read'), asyncHandler(async (req, res) => {
  await assertCanAccessRole(req.auth!, req.params.id);
  const entries = await prisma.orgCompetency.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { name: 'asc' } });
  res.json({
    competencies: entries.map((e) => ({
      id: e.id, name: e.name, category: e.category, definition: e.definition,
      indicators: parseJsonOptional<string[]>(e.indicatorsJson, [], { model: 'OrgCompetency', id: e.id, field: 'indicatorsJson' }),
    })),
  });
}));

roleCompetenciesRouter.post('/draft', requireCapability('role:edit_scorecard'), draftLimit, asyncHandler(async (req, res) => {
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const { name: competencyName } = draftSchema.parse(req.body ?? {});
  const latest = await latestScorecard(role.id);
  const profile = profileOf(latest);
  const { draft, source } = await draftCompetency({
    name: competencyName, roleTitle: role.title, jobDescription: role.sourceText, profile,
    techStack: roleTechStack(role), band: roleBand(role, profile.seniority),
  });
  res.json({ draft, source });
}));

roleCompetenciesRouter.post('/', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const body = addSchema.parse(req.body ?? {});
  const { role, before, profile } = await openForEdit(req.auth!, req.params.id);
  const input: CompetencyInput = 'libraryId' in body
    ? await libraryInput(role.tenantId, body.libraryId, { classification: body.classification, weight: body.weight, mustPass: body.mustPass })
    : body;
  let next: RoleSuccessProfile;
  try { next = addCompetency(profile, input); } catch (err) { asHttp(err); }
  const added = next.competencies[next.competencies.length - 1];
  const saved = await writeScorecardProfile(role.id, before, next);
  await rememberInLibrary(role.tenantId, req.auth!.userId, added);
  await logAudit({
    tenantId: role.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'role.scorecard.competency.added',
    entityType: 'RoleScorecardVersion', entityId: saved.id, after: summary(added),
  });
  res.status(201).json({ scorecard: shape(saved, next), competency: added, warnings: scorecardWarnings(next) });
}));

roleCompetenciesRouter.patch('/:competencyId', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const competencyId = competencyIdParam.parse(req.params.competencyId);
  const patch = patchSchema.parse(req.body ?? {});
  const { role, before, profile } = await openForEdit(req.auth!, req.params.id);
  const was = profile.competencies.find((c) => c.id === competencyId);
  let next: RoleSuccessProfile;
  try { next = updateCompetency(profile, competencyId, patch); } catch (err) { asHttp(err); }
  const now = next.competencies.find((c) => c.id === competencyId);
  const saved = await writeScorecardProfile(role.id, before, next);
  await logAudit({
    tenantId: role.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'role.scorecard.competency.updated',
    entityType: 'RoleScorecardVersion', entityId: saved.id, before: summary(was), after: summary(now),
  });
  res.json({ scorecard: shape(saved, next), warnings: scorecardWarnings(next) });
}));

roleCompetenciesRouter.delete('/:competencyId', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const competencyId = competencyIdParam.parse(req.params.competencyId);
  const { role, before, profile } = await openForEdit(req.auth!, req.params.id);
  const was = profile.competencies.find((c) => c.id === competencyId);
  // Deleting would leave old turns, plans and assessments pointing at nothing.
  const retire = (await competencyIdsWithHistory(role.id)).has(competencyId);
  let next: RoleSuccessProfile;
  try { next = retire ? retireCompetency(profile, competencyId) : removeCompetency(profile, competencyId); } catch (err) { asHttp(err); }
  const saved = await writeScorecardProfile(role.id, before, next);
  await logAudit({
    tenantId: role.tenantId, actorId: req.auth!.userId, actorType: 'user',
    action: retire ? 'role.scorecard.competency.retired' : 'role.scorecard.competency.removed',
    entityType: 'RoleScorecardVersion', entityId: saved.id, before: summary(was),
  });
  res.json({ scorecard: shape(saved, next), retired: retire, warnings: scorecardWarnings(next) });
}));
