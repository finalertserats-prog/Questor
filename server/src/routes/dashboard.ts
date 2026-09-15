import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { getDashboardMetrics } from '../services/dashboardMetrics.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate);

// Strict: an unexpected key is a client bug or a probe, and silently ignoring
// something like `tenantId` would suggest it did something.
const metricsQuerySchema = z.object({
  weeks: z.coerce.number().int().min(4).max(26).default(12),
  recent: z.coerce.number().int().min(1).max(20).default(8),
}).strict();

// Gated on candidate:read, matching GET /api/interviews: the payload names
// candidates in `recentInterviews`, and the auditor role is deliberately kept
// away from candidate detail. Counts are object-scoped in the service.
dashboardRouter.get('/metrics', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const query = metricsQuerySchema.parse(req.query);
  res.json(await getDashboardMetrics(req.auth!, query));
}));
