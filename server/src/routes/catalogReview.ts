import { Router, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { requirePlatformOperator } from '../middleware/platformOperator.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { approveProposal, BULK_REVIEW_MAX, bulkReview, rejectProposal, type ReviewResult } from '../services/catalogProposalReview.js';
import { editProposal } from '../services/catalogProposalEdit.js';
import { editOptions, listProposals, listRuns } from '../services/catalogProposalQuery.js';
import { startManualCatalogRefresh } from '../services/catalogRefresh.js';

/**
 * The platform owner's review queue for the monthly catalog refresh. Every
 * route is for platform operators only; nothing here is tenant data.
 */

export const catalogReviewRouter = Router();
catalogReviewRouter.use(authenticate, requirePlatformOperator);

const id = z.string().cuid();
const note = z.string().trim().max(1000).default('');

const listQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'superseded']).optional(),
  kind: z.enum(['new_role', 'new_alias']).optional(),
  domainId: id.optional(),
  source: z.enum(['onet', 'esco', 'web']).optional(),
  q: z.string().max(120).default(''),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

const editSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  domainId: id.nullable().optional(),
  familyId: id.nullable().optional(),
  summary: z.string().max(600).optional(),
  targetRoleId: id.nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change.' });

const decisionSchema = z.object({ note }).strict();
// The version the operator was looking at; approving a newer one is refused.
const approveSchema = z.object({ note, updatedAt: z.string().datetime().optional() }).strict();
const bulkSchema = z.object({ ids: z.array(id).min(1).max(BULK_REVIEW_MAX), action: z.enum(['approve', 'reject']), note }).strict();

// A manual run reads public sources and may spend on a model: a handful an hour is plenty.
const manualRunLimit = rateLimit({ name: 'catalog-refresh-manual', windowMs: 60 * 60_000, max: 6, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

function sendDecision(res: Response, result: ReviewResult): void {
  if (result.ok) {
    res.json({ status: result.status, ...(result.createdRoleId ? { createdRoleId: result.createdRoleId } : {}) });
    return;
  }
  res.status(result.httpStatus).json({ error: result.error, code: result.code, ...(result.existing ? { existing: result.existing } : {}) });
}

catalogReviewRouter.get('/proposals', asyncHandler(async (req, res) => {
  const { proposals, meta } = await listProposals(listQuerySchema.parse(req.query));
  res.json({ proposals, meta });
}));

catalogReviewRouter.patch('/proposals/:id', asyncHandler(async (req, res) => {
  const proposal = await editProposal(id.parse(req.params.id), editSchema.parse(req.body), req.auth!);
  res.json({ proposal });
}));

catalogReviewRouter.post('/proposals/bulk', asyncHandler(async (req, res) => {
  const body = bulkSchema.parse(req.body);
  const results = await bulkReview([...new Set(body.ids)], body.action, req.auth!, body.note);
  res.json({
    results: results.map((r) => (r.ok
      ? { id: r.id, ok: true, status: r.status }
      : { id: r.id, ok: false, code: r.code, error: r.error, ...(r.existing ? { existing: r.existing } : {}) })),
  });
}));

catalogReviewRouter.post('/proposals/:id/approve', asyncHandler(async (req, res) => {
  const body = approveSchema.parse(req.body ?? {});
  sendDecision(res, await approveProposal(id.parse(req.params.id), req.auth!, body.note, body.updatedAt ? new Date(body.updatedAt) : undefined));
}));

catalogReviewRouter.post('/proposals/:id/reject', asyncHandler(async (req, res) => {
  const body = decisionSchema.parse(req.body ?? {});
  sendDecision(res, await rejectProposal(id.parse(req.params.id), req.auth!, body.note));
}));

catalogReviewRouter.get('/options', asyncHandler(async (_req, res) => {
  res.json(await editOptions());
}));

catalogReviewRouter.get('/runs', asyncHandler(async (_req, res) => {
  res.json(await listRuns());
}));

catalogReviewRouter.post('/runs', manualRunLimit, asyncHandler(async (req, res) => {
  const started = await startManualCatalogRefresh(req.auth!.userId);
  if (started.kind === 'busy') throw new HttpError(409, 'A catalog refresh is already running.', 'already_running');
  if (started.kind === 'too_soon') {
    // Each manual run reads the sources again; they are spaced out so a few
    // clicks cannot multiply a month's reads and model spend.
    res.status(409).json({ error: `A manual run started recently. The next one can start after ${started.retryAt.toISOString().slice(11, 16)} UTC.`, code: 'too_soon', retryAt: started.retryAt.toISOString() });
    return;
  }
  if (started.kind === 'failed') throw new HttpError(500, 'The catalog refresh could not start. See the server log.');
  // 202: the run continues in the background; GET /runs shows its progress.
  res.status(202).json({ runId: started.runId });
}));
