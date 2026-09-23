import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { asyncHandler, authenticate, HttpError, requireCapability } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { loadPolicy } from '../library/policy.js';
import { selectLadders, snapshotOf } from '../library/select.js';
import { isReservedEntryId } from '../library/types.js';

/**
 * The library's tenant-facing read API. Mounted only when LIBRARY_ENABLED is
 * true; with it off, only GET /api/library/status exists and says so.
 *
 * `select` returns a ladder per competency, or an empty ladder when the pool
 * is thin — never an error, so the planner's fallback to the built-in bank is
 * the ordinary path, not an exception path.
 */

/** Always mounted: the one route that exists in the dark. */
export const libraryStatusRouter = Router();
libraryStatusRouter.get('/status', (_req, res) => {
  res.json({ enabled: config.library.enabled, workerEnabled: config.library.workerEnabled });
});

export const libraryRouter = Router();
libraryRouter.use(authenticate);

const slug = z.string().trim().min(1).max(160).regex(/^[a-z0-9-]+$/, 'slug');
const selectSchema = z.object({
  roleSlug: slug,
  band: z.enum(['emerging', 'developing', 'established', 'senior', 'principal', 'executive']),
  competencyKeys: z.array(slug).min(1).max(40),
  /** Probational entries are returned only to the demo sandbox (L1's interleaved trial). */
  includeProbational: z.boolean().default(false),
  /** Per competency key, what the candidate's CV shows; a strong signal draws a harder ladder. */
  cvSignals: z.record(slug, z.enum(['strong', 'thin', 'neutral'])).optional(),
}).strict();

// Planning an interview calls this once; a script hammering it is not planning interviews.
const selectLimit = rateLimit({ name: 'library-select', windowMs: 60_000, max: 120, keyOf: (req) => req.auth?.tenantId ?? req.ip ?? 'unknown' });

/**
 * Asking for a ladder is part of PLANNING an interview, so it is gated on the
 * capability that plans one. It answered anyone signed in until 2026-09-23 —
 * an `auditor`, whose one grant is `audit:read` ("sees that things happened,
 * not candidate detail"), got live question ladders back
 * (docs/qa/resilience-2026-09-23.md, S3). The check runs before any lookup,
 * so a refusal says nothing about what exists.
 */
libraryRouter.post('/select', requireCapability('interview:create'), selectLimit, asyncHandler(async (req, res) => {
  const body = selectSchema.parse(req.body ?? {});
  const auth = req.auth!;
  let includeProbational = false;
  if (body.includeProbational) {
    const tenant = await prisma.tenant.findUnique({ where: { id: auth.tenantId }, select: { isDemo: true } });
    includeProbational = tenant?.isDemo === true;
  }
  const policy = await loadPolicy();
  const ladders = await selectLadders({
    tenantId: auth.tenantId, roleSlug: body.roleSlug, band: body.band, competencyKeys: [...new Set(body.competencyKeys)],
    includeProbational, windowDays: policy.noRepeatWindowDays, ...(body.cvSignals ? { cvSignals: body.cvSignals } : {}),
  });
  res.json({ ladders, includeProbational });
}));

/**
 * Resolving one question, which is what a transcript needs: gated on reading
 * an interview rather than on planning one, so a reviewer who never plans can
 * still see the question a candidate was asked. Tenant scope is in the query
 * below and is not relaxed by the capability.
 */
libraryRouter.get('/entries/:id', requireCapability('interview:read'), asyncHandler(async (req, res) => {
  const id = z.string().min(1).max(64).parse(req.params.id);
  if (isReservedEntryId(id)) throw new HttpError(404, 'Not found');
  const auth = req.auth!;
  const entry = await prisma.libraryEntry.findFirst({
    where: { id, OR: [{ scope: 'global' }, { scope: 'org', tenantId: auth.tenantId }] },
    select: { id: true, competencyKey: true, form: true, difficultyTag: true, questionText: true, bodyJson: true, standardId: true, supersedesId: true, status: true },
  });
  // A retired or rejected entry still resolves for a transcript that asked it; a draft never leaves the owner's screen.
  if (!entry || entry.status === 'draft') throw new HttpError(404, 'Not found');
  res.json({ snapshot: snapshotOf(entry), status: entry.status });
}));
