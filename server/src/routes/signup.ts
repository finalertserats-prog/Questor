import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { passwordSchema } from '../domain/passwordPolicy.js';
import { createSignupRequest, decideSignupRequest, resolveSignupDecision, signupApplicant } from '../services/signup.js';
import { listBusinessAreas } from '../services/businessAreas.js';
import { prisma } from '../db.js';
import { DEFAULT_BUSINESS_AREA_LIMIT, ORG_SIZES, ORG_SIZE_IDS } from '../domain/orgOnboarding.js';
import { detectInjection } from '../engines/policyEngine.js';

export const signupRouter = Router();
export const signupDecisionRouter = Router();

/**
 * The organisation name is free text typed by a stranger that later reaches a
 * model's context as the organisation's name, and reaches the owner's console
 * as a line to read. Screened the same way every other piece of organisation
 * text is (engines/policyEngine.ts) rather than with a second, weaker rule.
 */
function organisationText(max: number) {
  return z.string().trim().min(1).max(max).superRefine((value, ctx) => {
    if (/[\r\n]/.test(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'This must be a single line.' });
    if (detectInjection(value).injection) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'This text cannot be accepted. Please write the organisation name plainly.' });
    }
  });
}

const signupSchema = z.discriminatedUnion('mode', [
  z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    password: passwordSchema,
    mode: z.literal('new-org'),
    organisationName: organisationText(200),
    orgCode: z.string().optional(),
    // The onboarding form's own fields. Optional so the sign-in lane's
    // existing new-organisation request keeps working unchanged; the form
    // sends all of them.
    regionCode: z.string().trim().min(1).max(20).optional(),
    orgSize: z.enum(ORG_SIZE_IDS as [string, ...string[]]).optional(),
    businessAreas: z.array(z.string().trim().min(1).max(80))
      .max(DEFAULT_BUSINESS_AREA_LIMIT, `Choose up to ${DEFAULT_BUSINESS_AREA_LIMIT} business areas.`)
      .optional(),
  }).strict(),
  z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    password: passwordSchema,
    mode: z.literal('join'),
    orgCode: z.string().min(1).max(64),
    organisationName: z.string().optional(),
  }).strict(),
]);

const decisionSchema = z.object({ decision: z.enum(['approve', 'decline']) }).strict();

/**
 * What the public onboarding form has to offer before anyone is signed in:
 * the catalog's own regions, its business areas, and the size bands. All three
 * are curated lists that every organisation already shares — nothing here is
 * specific to any organisation, and nothing here says whether one exists.
 */
signupRouter.get('/options', asyncHandler(async (_req, res) => {
  const [regions, businessAreas] = await Promise.all([
    prisma.catalogRegion.findMany({ where: { status: 'active' }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true } }),
    listBusinessAreas(),
  ]);
  res.json({
    regions,
    businessAreas: businessAreas.map(({ slug, name, summary }) => ({ slug, name, summary })),
    sizes: ORG_SIZES,
    businessAreaLimit: DEFAULT_BUSINESS_AREA_LIMIT,
  });
}));

signupRouter.post('/', asyncHandler(async (req, res) => {
  const body = signupSchema.parse(req.body);
  if (body.mode === 'new-org') {
    // Checked against the live catalog, not only against the shape. A slug the
    // catalog does not have would otherwise be stored, silently dropped at
    // approval, and leave the organisation wondering where an area went.
    if (body.regionCode) {
      const region = await prisma.catalogRegion.findFirst({ where: { code: body.regionCode, status: 'active' }, select: { code: true } });
      if (!region) throw new HttpError(400, 'Choose a region from the list.');
    }
    if (body.businessAreas?.length) {
      const known = new Set((await listBusinessAreas()).map((a) => a.slug));
      if (new Set(body.businessAreas).size !== body.businessAreas.length) throw new HttpError(400, 'Each business area can only be chosen once.');
      if (body.businessAreas.some((slug) => !known.has(slug))) throw new HttpError(400, 'Choose business areas from the list.');
    }
  }
  await createSignupRequest(body);
  // The same answer for a request that was created, a request suppressed by
  // the name cooldown, and a name that already belongs to someone. Anything
  // else would be a lookup service for who uses Questor.
  res.status(201).json({ status: 'pending' });
}));

signupDecisionRouter.get('/:token', asyncHandler(async (req, res) => {
  const row = await resolveSignupDecision(req.params.token);
  res.json({ state: row.status === 'PENDING' ? 'open' : 'decided', applicant: signupApplicant(row) });
}));

signupDecisionRouter.post('/:token', asyncHandler(async (req, res) => {
  const { decision } = decisionSchema.parse(req.body);
  const { transitioned } = await decideSignupRequest({ token: req.params.token, decision, actorId: 'signup-link' });
  // Reporting success for a decision nobody made is how a stale tab, a second
  // click, or a race with another admin all look like they worked.
  if (!transitioned) throw new HttpError(409, 'This request has already been decided.');
  res.json({ recorded: true });
}));
