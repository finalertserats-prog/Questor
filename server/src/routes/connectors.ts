import { Router } from 'express';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireOperator } from '../middleware/operator.js';
import { logAudit } from '../services/audit.js';
import { logger } from '../logger.js';
import { isMeetingAdapterId, missingEnv, type MeetingAdapterId } from '../providers/meeting/connectorEnv.js';
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

// The credentials are deployment-wide. Only the operator can test them now,
// but the second limiter stays keyed by adapter alone, so the vendor app sees
// a bounded request rate whoever is testing.
const CONNECTOR_TEST_GLOBAL_MAX = 30;
const connectorTestGlobalLimiter = rateLimit({
  name: 'connector-test-global',
  windowMs: CONNECTOR_TEST_WINDOW_MS,
  max: CONNECTOR_TEST_GLOBAL_MAX,
  keyOf: (req) => String(req.params.adapterId),
});

connectorsRouter.post(
  '/meeting/:adapterId/test',
  // Capability and operator before anything else, so nobody else can probe
  // adapter ids. These are the deployment's shared vendor apps: a tenant admin
  // testing them was spending, and learning about, credentials that are not
  // their organisation's. A tenant tests its own ATS at /api/admin/ats/test.
  requireCapability('admin:manage'),
  requireOperator({
    forbidden: 'Only the deployment operator can test meeting connectors.',
    unconfigured: 'Only the deployment operator can test meeting connectors, and none is configured on this server.',
    unconfiguredStatus: 403,
  }),
  // Then the adapter id, before the limiters: a typo should not spend an
  // admin's quota, and an arbitrary id should not open a rate-limit bucket.
  (req, res, next) => {
    if (isMeetingAdapterId(req.params.adapterId)) { next(); return; }
    const message = 'Unknown meeting adapter.';
    res.status(404).json({ ok: false, message, error: message });
  },
  connectorTestLimiter,
  connectorTestGlobalLimiter,
  asyncHandler(async (req, res) => {
    const adapterId = req.params.adapterId as MeetingAdapterId;

    const auth = req.auth!;
    const audit = (outcome: 'ok' | 'failed' | 'not_configured') => {
      // The audit row lands in the operator's own tenant; the application log
      // is the deployment-wide trail.
      logger.info({ tenantId: auth.tenantId, userId: auth.userId, adapterId, outcome }, 'connector.tested');
      return logAudit({
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
    };

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
