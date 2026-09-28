import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { ATS_PROVIDERS } from '../providers/ats/index.js';
import {
  disconnectConnection,
  findConnection,
  saveConnection,
  shapeConnection,
  testTenantConnection,
} from '../services/atsConnections.js';

// The organisation's own ATS connection, managed by its admins.
//
// The API key is write-only: it is accepted here, sealed, and never sent back.
// The response says only whether one is set.

export const atsConnectionRouter = Router();
atsConnectionRouter.use(authenticate);
atsConnectionRouter.use(requireCapability('admin:manage'));

const saveSchema = z.object({
  provider: z.enum(ATS_PROVIDERS).default('generic'),
  baseUrl: z.string().trim().min(1).max(500),
  accountId: z.string().trim().max(200).regex(/^[A-Za-z0-9._@-]*$/, 'An account id is letters, numbers, dots, dashes, underscores or @.').default(''),
  // Empty or absent keeps the stored key, so an admin can change the address
  // without retyping a secret they may not have to hand.
  apiKey: z.string().max(2000).optional(),
}).strict();

atsConnectionRouter.get('/', asyncHandler(async (req, res) => {
  const row = await findConnection(req.auth!.tenantId);
  res.json({ connection: row ? shapeConnection(row) : null });
}));

atsConnectionRouter.put('/', asyncHandler(async (req, res) => {
  const body = saveSchema.parse(req.body);
  const row = await saveConnection({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, requestId: req.requestId,
    provider: body.provider, baseUrl: body.baseUrl, accountId: body.accountId,
    apiKey: body.apiKey?.trim() || undefined,
  });
  res.json({ connection: shapeConnection(row) });
}));

atsConnectionRouter.delete('/', asyncHandler(async (req, res) => {
  const row = await disconnectConnection({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, requestId: req.requestId });
  res.json({ connection: shapeConnection(row) });
}));

// Each test is a real authenticated call to the organisation's ATS. Limited per
// user and per tenant, so minting more admins does not buy more calls.
const TEST_WINDOW_MS = 10 * 60_000;
const testPerUser = rateLimit({ name: 'ats-test', windowMs: TEST_WINDOW_MS, max: 10, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });
const testPerTenant = rateLimit({ name: 'ats-test-tenant', windowMs: TEST_WINDOW_MS, max: 30, keyOf: (req) => req.auth?.tenantId ?? 'unknown' });

// Only ever the caller's own tenant: there is no id in the path to point at
// anyone else's connection.
atsConnectionRouter.post('/test', testPerUser, testPerTenant, asyncHandler(async (req, res) => {
  const result = await testTenantConnection({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, requestId: req.requestId });
  const row = await findConnection(req.auth!.tenantId);
  res.json({ ok: result.ok, message: result.message, connection: row ? shapeConnection(row) : null });
}));
