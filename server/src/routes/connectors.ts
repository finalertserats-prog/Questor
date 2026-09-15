import { Router } from 'express';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logAudit } from '../services/audit.js';
import { isMeetingAdapterId, missingEnv } from '../providers/meeting/connectorEnv.js';
import { testMeetingConnection } from '../providers/meeting/connectionTest.js';

// Connector connection tests.
//
// Credentials are read from server/.env only. There is deliberately no endpoint
// that accepts or stores an API key: keys in the database would put every
// tenant's vendor access one SQL injection or backup leak away, and connectors
// are deployment-wide (one server, one Zoom app), not per-tenant settings.

export const connectorsRouter = Router();
connectorsRouter.use(authenticate);

const CONNECTOR_TEST_WINDOW_MS = 10 * 60_000;
const CONNECTOR_TEST_MAX = 10;

// Keyed by user: each test makes a real authenticated call to a vendor, and
// hammering a token endpoint can get the organisation's app throttled or flagged.
const connectorTestLimiter = rateLimit({
  name: 'connector-test',
  windowMs: CONNECTOR_TEST_WINDOW_MS,
  max: CONNECTOR_TEST_MAX,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

connectorsRouter.post(
  '/meeting/:adapterId/test',
  // Capability before anything else, so a non-admin cannot probe adapter ids.
  requireCapability('admin:manage'),
  connectorTestLimiter,
  asyncHandler(async (req, res) => {
    const { adapterId } = req.params;
    if (!isMeetingAdapterId(adapterId)) {
      const message = 'Unknown meeting adapter.';
      res.status(404).json({ ok: false, message, error: message });
      return;
    }

    const auth = req.auth!;
    const audit = (outcome: 'ok' | 'failed' | 'not_configured') => logAudit({
      tenantId: auth.tenantId,
      actorType: 'user',
      actorId: auth.userId,
      action: 'connector.tested',
      entityType: 'Connector',
      entityId: `meeting:${adapterId}`,
      // Adapter and outcome only. The result message is not stored: it is
      // derived from vendor behaviour and does not belong in a compliance log.
      after: { adapterId, outcome },
      requestId: req.requestId,
    });

    const missing = missingEnv(adapterId);
    if (missing.length > 0) {
      await audit('not_configured');
      const message = `Not configured yet. Set ${missing.join(', ')} in server/.env, restart the server, then test again. See "How to set up" for where to get each value.`;
      res.status(409).json({ ok: false, message, error: message });
      return;
    }

    const result = await testMeetingConnection(adapterId);
    await audit(result.ok ? 'ok' : 'failed');
    res.json({ ok: result.ok, message: result.message });
  }),
);
