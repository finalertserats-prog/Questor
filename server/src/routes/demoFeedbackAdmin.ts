import { Router } from 'express';
import { asyncHandler, authenticate } from '../middleware/index.js';
import { requirePlatformOperator } from '../middleware/platformOperator.js';
import { listDemoFeedback } from '../services/demoFeedback.js';
import { DEMO_SPEND_CEILINGS } from '../services/demoInterviewRun.js';
import { prisma } from '../db.js';
import { spendDayKey } from '../domain/demoBudget.js';

/**
 * What prospects said about the demo, for the owner.
 *
 * PLATFORM OWNER ONLY, not organisation admins. A demo request comes from
 * outside every organisation, and what a stranger thought of the product is
 * the owner's business and nobody else's — an admin of one customer has no
 * standing to read another prospect's opinion, or their name and address.
 * `requirePlatformOperator` also refuses demo sessions outright, so a visitor
 * whose address happens to match the operator's cannot reach their own file.
 */
export const demoFeedbackAdminRouter = Router();
demoFeedbackAdminRouter.use(authenticate, requirePlatformOperator);

demoFeedbackAdminRouter.get('/', asyncHandler(async (_req, res) => {
  const rows = await listDemoFeedback();
  const dayKey = spendDayKey(new Date());
  const day = await prisma.demoSpendDay.findUnique({ where: { dayKey }, select: { calls: true } });
  res.json({
    feedback: rows,
    // Beside the feedback because the two are read together: "the interviewer
    // felt wooden" means something different on a day the ceiling was reached
    // and every demo after it ran on the built-in writer.
    spend: { dayKey, used: day?.calls ?? 0, ceiling: DEMO_SPEND_CEILINGS.perDay, perRun: DEMO_SPEND_CEILINGS.perRun },
  });
}));
