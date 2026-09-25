import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { getDashboardMetrics } from '../services/dashboardMetrics.js';
import { getRoleMetrics } from '../services/roleMetrics.js';
import { listHeldFeedback } from '../services/feedbackHold.js';
import { countNeedsYou, getNeedsYou } from '../services/needsYouFeed.js';
import { pagingQuerySchema } from '../services/listPaging.js';

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
  const [metrics, roleMetrics] = await Promise.all([
    getDashboardMetrics(req.auth!, query),
    getRoleMetrics(req.auth!, { activeOnly: true }),
  ]);
  res.json({
    ...metrics,
    truncated: metrics.truncated || roleMetrics.truncated,
    roles: {
      kpis: roleMetrics.kpis,
      topByApplied: roleMetrics.topByApplied,
      topByInterviewed: roleMetrics.topByInterviewed,
      minSample: roleMetrics.minSample,
    },
  });
}));

// Feedback emails held because the interview could not be relied on
// (services/feedbackHold.ts): the query a hiring-team inbox reads. Awaiting a
// decision by default; includeKept adds the ones someone chose to keep held.
// Gated like the assessment page that shows them, and object-scoped.
const heldQuerySchema = z.object({ includeKept: z.enum(['true', 'false']).optional() }).strict();

dashboardRouter.get('/held-feedback', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const query = heldQuerySchema.parse(req.query);
  res.json(await listHeldFeedback(req.auth!, { includeKept: query.includeKept === 'true' }));
}));

// HR-Box (services/needsYouFeed.ts): what needs the caller, what is coming up
// and what was done. Gated like /metrics, which names candidates the same way;
// each queue kind is further limited to people who may do its action, and
// every row is object-scoped. The queue pages on the server.
const needsYouQuerySchema = pagingQuerySchema.omit({ q: true }).strict();

dashboardRouter.get('/needs-you', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const paging = needsYouQuerySchema.parse(req.query);
  res.json(await getNeedsYou(req.auth!, paging));
}));

// The header bell's number. Counts only, so it is cheap to poll.
dashboardRouter.get('/needs-you/count', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  z.object({}).strict().parse(req.query);
  res.json(await countNeedsYou(req.auth!));
}));
