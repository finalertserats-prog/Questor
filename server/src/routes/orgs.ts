import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';

/**
 * Public, unauthenticated: resolves an organisation's own sign-in link, and
 * finds one by the first letters of its name.
 *
 * This file previously stated that there was deliberately no listing endpoint.
 * That changed on purpose: sign-in now starts by choosing your organisation, and
 * expecting someone to have memorised a slug stranded anyone who was never told
 * it. The search below is the narrowest thing that makes that work, because the
 * names ARE the customer list:
 *
 *   - Three characters minimum. A single letter would walk the alphabet.
 *   - Prefix match only, never substring, so "health" does not surface
 *     ScaleHealthTech to someone fishing for sector words.
 *   - A handful of results, and only organisations that have a sign-in link at
 *     all; one without a slug cannot be signed into and is nobody's business.
 *   - An organisation may ask not to appear at all (Tenant.listed), which some
 *     enterprise customers will; their own link still works.
 *   - Rate limited with the rest of this router in app.ts.
 *
 * It remains a disclosure, and an accepted one: someone who already knows a name
 * can confirm that organisation uses Questor. What it stops is harvesting the
 * list without knowing any of it.
 */
export const orgsRouter = Router();

export const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** The shortest prefix worth answering. Two letters matches far too much. */
const MIN_SEARCH = 3;
// Five. The step exists so someone can find their own employer, and anyone
// who cannot see it in five close matches types another letter. A longer list
// is a longer answer to a fishing question.
const MAX_RESULTS = 5;

orgsRouter.get('/', asyncHandler(async (req, res) => {
  const parsed = z.string().trim().min(MIN_SEARCH).max(64).safeParse(req.query.q);
  // A query too short to be a real attempt is answered with an empty list, not
  // an error: the sign-in box calls this on every keystroke.
  if (!parsed.success) {
    res.json({ orgs: [] });
    return;
  }
  // Compared in application code rather than with Prisma's `mode: 'insensitive'`,
  // which SQLite does not support: using it would have thrown here in every test
  // and in local development while working only against production Postgres.
  // Lowercasing both sides also makes the two engines agree, since SQLite's LIKE
  // folds ASCII case and Postgres's startsWith does not.
  const needle = parsed.data.toLowerCase();
  const candidates = await prisma.tenant.findMany({
    // Demo sandboxes are nobody's organisation to sign in to, and their names
    // ("<company> (demo)") would disclose who asked for a demo.
    // `listed: false` is an organisation that asked not to appear here. Their
    // people arrive through /o/<slug>, which keeps working — the setting hides
    // the name from the search, it does not close the door.
    where: { slug: { not: null }, isDemo: false, listed: true },
    select: { name: true, slug: true },
    orderBy: { name: 'asc' },
  });
  const orgs = candidates
    .filter((org) => org.name.toLowerCase().startsWith(needle))
    .slice(0, MAX_RESULTS);
  res.json({ orgs });
}));

orgsRouter.get('/:slug', asyncHandler(async (req, res) => {
  const parsed = z.string().regex(ORG_SLUG).safeParse(req.params.slug);
  const tenant = parsed.success
    ? await prisma.tenant.findFirst({ where: { slug: parsed.data, isDemo: false }, select: { name: true, slug: true } })
    : null;
  if (!tenant?.slug) throw new HttpError(404, 'Organization not found');
  res.json({ org: { name: tenant.name, slug: tenant.slug } });
}));
