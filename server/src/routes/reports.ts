import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { getOutcomeReport } from '../services/outcomeStats.js';
import { outcomeReportToCsv } from '../services/outcomeCsv.js';
import { listOutcomeSnapshots } from '../services/outcomeSnapshot.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

/**
 * Outcome statistics.
 *
 * GATE. `assessment:export`, which only `manager` and `admin` hold. Not
 * `assessment:read`: that also admits `recruiter` and `reviewer`, and this
 * payload is an organisation-wide view of how every candidate fared — the
 * aggregate-disclosure question routes/admin.ts already records as open for
 * /analytics. A recruiter who can see two requisitions should not learn the
 * whole organisation's outcome rates from a page. Not `requireOperator`
 * either: an operator is the deployment's owner, and an organisation's own
 * hiring outcomes are the organisation's to read.
 *
 * Every count is still object-scoped inside the service (roleScope +
 * candidateScope), so a manager with assignment limits sees their own scope.
 *
 * Strict query: an unexpected key is a client bug or a probe, and quietly
 * ignoring something like `tenantId` would suggest it had done something.
 */
const outcomesQuerySchema = z.object({
  /** Inclusive start, ISO date or datetime. Defaults to a year before `to`. */
  from: z.coerce.date().optional(),
  /** Exclusive end. Defaults to now. */
  to: z.coerce.date().optional(),
  roleId: z.string().min(1).max(64).optional(),
  format: z.enum(['csv']).optional(),
}).strict().refine((q) => !q.from || !q.to || q.from < q.to, {
  message: 'The start of the period must come before its end.',
  path: ['from'],
});

reportsRouter.get('/outcomes', requireCapability('assessment:export'), asyncHandler(async (req, res) => {
  const query = outcomesQuerySchema.parse(req.query);
  const report = await getOutcomeReport(req.auth!, {
    period: { ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) },
    ...(query.roleId ? { roleId: query.roleId } : {}),
  });

  if (query.format === 'csv') {
    res.type('text/csv');
    // Named so a download that leaves the browser still says what period it is
    // of; a bare "outcomes.csv" on a desktop is a number with no denominator.
    res.set('Content-Disposition', `attachment; filename="questor-outcomes-${report.period.from.slice(0, 10)}-to-${report.period.to.slice(0, 10)}.csv"`);
    res.send(outcomeReportToCsv(report));
    return;
  }
  res.json(report);
}));

/**
 * The stored monthly aggregates, so a trend survives the data it was computed
 * from being erased. Empty until OUTCOME_SNAPSHOT_ENABLED has been on for a
 * month — an empty list means "not kept", never "nothing happened", and the
 * page says which.
 *
 * Gated more tightly than the live report, on `admin:manage`. A snapshot is a
 * WHOLE-ORGANISATION aggregate: it was written by the sweep, not by a reader,
 * and it cannot be narrowed to one manager's assigned roles after the fact
 * without recomputing it from data that may no longer exist. Serving it on
 * `assessment:export` would hand an assignment-limited manager the history of
 * roles their live report is scoped away from.
 */
reportsRouter.get('/outcomes/snapshots', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  z.object({}).strict().parse(req.query);
  res.json({ months: await listOutcomeSnapshots(req.auth!.tenantId) });
}));
