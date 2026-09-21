import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, requireCapability } from '../middleware/index.js';
import { TECHNOLOGIES, detectTechStack, techStackInputSchema, techStackNames } from '../domain/techStack.js';
import { logAudit } from '../services/audit.js';
import { assertCanAccessRole } from '../services/access.js';
import { assertRoleOpen } from '../services/roleOpen.js';
import { latestScorecard, profileOf } from '../services/scorecardVersions.js';
import { planTechStackChange, roleBand, roleTechStack } from '../services/roleTechStack.js';

/**
 * /api/roles/:id/tech-stack — the technologies a role is hired around.
 *
 * The stack is replaced whole; the job description's "Tech stack" section
 * follows it only when the caller says so (`updateJd`), after the page has
 * shown the before and after. The reply carries the competencies the new
 * stack suggests; adding one is a separate, confirmed step through
 * /scorecard/competencies, so nothing reaches the scorecard unread.
 */
export const roleTechStackRouter = Router({ mergeParams: true });

const stackBody = z.object({ techStack: techStackInputSchema }).strict();
const patchBody = stackBody.extend({ updateJd: z.boolean().default(false) }).strict();

const roleSelect = { id: true, tenantId: true, title: true, sourceText: true, techStackJson: true, experienceBand: true } as const;

roleTechStackRouter.post('/preview', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const { techStack } = stackBody.parse(req.body ?? {});
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  const row = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, select: roleSelect });
  const profile = profileOf(await latestScorecard(role.id));
  const change = planTechStackChange({ sourceText: row.sourceText, next: techStack, profile, band: roleBand(row, profile.seniority) });
  res.json({ techStack, jd: shapeJd(change.jd), proposals: change.proposals });
}));

roleTechStackRouter.patch('/', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const body = patchBody.parse(req.body ?? {});
  const role = await assertCanAccessRole(req.auth!, req.params.id);
  await assertRoleOpen(role.id);
  const row = await prisma.role.findUniqueOrThrow({ where: { id: role.id }, select: roleSelect });
  const before = roleTechStack(row);
  const profile = profileOf(await latestScorecard(role.id));
  const change = planTechStackChange({ sourceText: row.sourceText, next: body.techStack, profile, band: roleBand(row, profile.seniority) });
  const jdUpdated = body.updateJd && change.jd.changed;
  await prisma.role.update({
    where: { id: role.id },
    data: { techStackJson: JSON.stringify(body.techStack), ...(jdUpdated ? { sourceText: change.jd.text } : {}) },
  });
  await logAudit({
    tenantId: row.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'role.tech_stack.updated', entityType: 'Role', entityId: role.id,
    before: { techStack: techStackNames(before) },
    after: { techStack: techStackNames(body.techStack), jdUpdated },
  });
  res.json({ techStack: body.techStack, jd: { ...shapeJd(change.jd), updated: jdUpdated }, proposals: change.proposals });
}));

function shapeJd(jd: ReturnType<typeof planTechStackChange>['jd']) {
  // The JD text itself stays on the server: the page only needs the section.
  return { changed: jd.changed, kind: jd.kind, before: jd.before, after: jd.after, lint: jd.lint };
}

/**
 * /api/roles/tech-stack — helpers that need no role: the technologies the
 * editor suggests, and what a pasted job description already names.
 */
export const techStackToolsRouter = Router();

// A pasted JD: bounded like the one role creation accepts.
const detectBody = z.object({ text: z.string().max(50_000) }).strict();

techStackToolsRouter.get('/catalog', requireCapability('role:read'), (_req, res) => {
  res.json({ technologies: TECHNOLOGIES.map((t) => ({ name: t.name, category: t.category })) });
});

techStackToolsRouter.post('/detect', requireCapability('role:read'), (req, res) => {
  const { text } = detectBody.parse(req.body ?? {});
  res.json({ techStack: detectTechStack(text) });
});
