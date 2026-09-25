import { Router, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { requirePlatformOperator } from '../middleware/platformOperator.js';
import { approveEntry, editEntry, entryWithHistory, noteEntry, overview, ownerQueue, poolHealthRows, QUEUE_PAGE, ratesByStratum, rejectEntry, retireEntry, sampleEntries, type Owner } from '../library/admin.js';
import { isReservedEntryId } from '../library/types.js';
import type { TransitionResult } from '../library/lifecycle.js';
import { loadTrialReport } from '../library/trialReport.js';

/**
 * The platform owner's library screen: pool health, the owner queue, today's
 * stratified sample, rates by stratum, budget burn, worker state, and the
 * per-entry view. Operator only; mounted with the library or the worker on.
 */

export const libraryAdminRouter = Router();
libraryAdminRouter.use(authenticate, requirePlatformOperator);

const id = z.string().trim().min(1).max(64).refine((v) => !isReservedEntryId(v), 'reserved');
const note = z.string().trim().max(1000).default('');
const queueQuery = z.object({
  roleSlug: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(QUEUE_PAGE),
}).strict();
const decisionSchema = z.object({ note }).strict();
const rejectSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
const editSchema = z.object({
  questionText: z.string().trim().min(20).max(600),
  form: z.string().trim().max(40).optional(),
  difficultyTag: z.number().int().min(1).max(3).optional(),
}).strict();

function owner(req: { auth?: { userId: string; tenantId: string } }): Owner {
  return { userId: req.auth!.userId, tenantId: req.auth!.tenantId };
}

function sendTransition(res: Response, result: TransitionResult, status: string): void {
  if (result.ok) {
    res.json({ status, from: result.from });
    return;
  }
  if (result.code === 'not_found') throw new HttpError(404, 'Entry not found');
  throw new HttpError(409, 'That entry can no longer make this change.', 'invalid_transition');
}

libraryAdminRouter.get('/overview', asyncHandler(async (_req, res) => {
  res.json(await overview());
}));

libraryAdminRouter.get('/pools', asyncHandler(async (_req, res) => {
  res.json({ pools: await poolHealthRows() });
}));

libraryAdminRouter.get('/queue', asyncHandler(async (req, res) => {
  const query = queueQuery.parse(req.query);
  const { entries, total } = await ownerQueue(query);
  res.json({ entries, meta: { total, page: query.page, limit: query.limit } });
}));

libraryAdminRouter.get('/sample', asyncHandler(async (_req, res) => {
  res.json({ entries: await sampleEntries() });
}));

// The interleaved trial's paired report: library blocks against built-in blocks of the same interviews.
libraryAdminRouter.get('/trial-report', asyncHandler(async (_req, res) => {
  res.json({ report: await loadTrialReport() });
}));

libraryAdminRouter.get('/strata', asyncHandler(async (_req, res) => {
  res.json({ strata: await ratesByStratum() });
}));

libraryAdminRouter.get('/entries/:id', asyncHandler(async (req, res) => {
  const found = await entryWithHistory(id.parse(req.params.id));
  if (!found) throw new HttpError(404, 'Entry not found');
  res.json(found);
}));

libraryAdminRouter.post('/entries/:id/approve', asyncHandler(async (req, res) => {
  const body = decisionSchema.parse(req.body ?? {});
  sendTransition(res, await approveEntry(id.parse(req.params.id), owner(req), body.note), 'probational');
}));

libraryAdminRouter.post('/entries/:id/reject', asyncHandler(async (req, res) => {
  const body = rejectSchema.parse(req.body ?? {});
  sendTransition(res, await rejectEntry(id.parse(req.params.id), owner(req), body.reason), 'rejected');
}));

libraryAdminRouter.post('/entries/:id/retire', asyncHandler(async (req, res) => {
  const body = decisionSchema.parse(req.body ?? {});
  sendTransition(res, await retireEntry(id.parse(req.params.id), owner(req), body.note), 'retired');
}));

libraryAdminRouter.post('/entries/:id/edit', asyncHandler(async (req, res) => {
  const body = editSchema.parse(req.body ?? {});
  const result = await editEntry(id.parse(req.params.id), owner(req), body);
  if (result.ok) {
    res.json({ status: 'draft', newId: result.newId });
    return;
  }
  if (result.code === 'lint') {
    res.status(422).json({ error: 'The edited question fails the linter.', code: 'lint', problems: result.problems ?? [] });
    return;
  }
  if (result.code === 'not_found') throw new HttpError(404, 'Entry not found');
  throw new HttpError(409, 'That entry can no longer be edited.', 'invalid_transition');
}));

libraryAdminRouter.post('/entries/:id/note', asyncHandler(async (req, res) => {
  const body = z.object({ note: z.string().trim().min(1).max(1000) }).strict().parse(req.body ?? {});
  await noteEntry(id.parse(req.params.id), owner(req), body.note);
  res.json({ ok: true });
}));
