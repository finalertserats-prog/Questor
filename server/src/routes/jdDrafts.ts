
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { draftFromDescription, generatePendingDrafts, getOrQueueDraft, shapeDraft } from '../services/jdDrafts.js';

export const jdDraftsRouter = Router();
jdDraftsRouter.use(authenticate);

const querySchema = z.object({
  catalogRoleId: z.string().cuid(),
  experienceBand: z.string().min(1).max(40),
  regionCode: z.string().min(1).max(20),
}).strict();

jdDraftsRouter.get('/', requireCapability('role:create'), asyncHandler(async (req, res) => {
  const query = querySchema.parse(req.query);
  const draft = await getOrQueueDraft(query);
  if (draft.status === 'pending') void generatePendingDrafts({ limit: 5 });
  const body = shapeDraft(draft);
  if (draft.status === 'ready') res.status(200).json(body);
  else if (draft.status === 'failed') res.status(200).json({ ...body, message: 'We could not prepare this draft yet. You can try again or paste your own JD.' });
  else res.status(202).json({ ...body, text: '' });
}));

const describeSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(40).max(4000),
  experienceBand: z.string().min(1).max(40),
  regionCode: z.string().min(1).max(20),
  domainId: z.string().cuid().optional(),
}).strict();

jdDraftsRouter.post('/describe', requireCapability('role:create'), asyncHandler(async (req, res) => {
  const body = describeSchema.parse(req.body);
  res.json(await draftFromDescription({ auth: req.auth!, description: body.description, title: body.title, band: body.experienceBand, regionCode: body.regionCode, domainId: body.domainId }));
}));
