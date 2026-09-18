import { Router } from 'express';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { isOperator } from '../middleware/operator.js';
import { getSystemHealth } from '../services/systemHealth.js';

/**
 * GET /api/admin/health — the Admin console's "System health" panel.
 *
 * Any admin may call it; what comes back depends on who they are. The
 * deployment operator (the signup approver) gets the whole deployment plus
 * their own organisation; every other admin gets their own organisation only.
 */
export const systemHealthRouter = Router();
systemHealthRouter.use(authenticate);

systemHealthRouter.get('/', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const report = await getSystemHealth({ operator: isOperator(req.auth), tenantId: req.auth!.tenantId });
  // Per-user content: never let a shared cache hand one admin's view to another.
  res.set('Cache-Control', 'private, no-store');
  res.json(report);
}));
