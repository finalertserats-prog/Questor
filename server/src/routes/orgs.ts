import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';

/**
 * Public, unauthenticated: resolves an organisation's own sign-in link.
 *
 * It answers for one slug at a time and there is deliberately no listing
 * endpoint. Readable links like /o/acme are a product choice, and they mean a
 * visitor who guesses a slug learns that organisation uses Questor; the route
 * is tightly rate limited in app.ts so that cannot be done at scale. Only the
 * display name is returned.
 */
export const orgsRouter = Router();

export const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

orgsRouter.get('/:slug', asyncHandler(async (req, res) => {
  const parsed = z.string().regex(ORG_SLUG).safeParse(req.params.slug);
  const tenant = parsed.success
    ? await prisma.tenant.findUnique({ where: { slug: parsed.data }, select: { name: true, slug: true } })
    : null;
  if (!tenant?.slug) throw new HttpError(404, 'Organization not found');
  res.json({ org: { name: tenant.name, slug: tenant.slug } });
}));
