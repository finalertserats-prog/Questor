import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireRole } from '../middleware/index.js';
import { config } from '../config.js';
import { sttCapability, ttsCapability } from '../providers/speech.js';
import { getLlm } from '../providers/llm/index.js';
import { getEmail } from '../providers/email/index.js';
import { getAts } from '../providers/ats/index.js';
import { allMeetingCapabilities } from '../providers/meeting/index.js';

export const adminRouter = Router();
adminRouter.use(authenticate);

// Provider / connector status — shows which paid components are plugged in.
adminRouter.get('/providers', asyncHandler(async (_req, res) => {
  const llm = getLlm();
  res.json({
    llm: { provider: llm.name, enabled: llm.enabled, configured: llm.enabled, mode: llm.enabled ? 'remote' : 'built-in heuristic' },
    stt: sttCapability(),
    tts: ttsCapability(),
    email: { provider: getEmail().name, configured: getEmail().configured },
    ats: { provider: getAts().name, configured: getAts().configured },
    meeting: allMeetingCapabilities(),
  });
}));

// Audit log (FR-038)
adminRouter.get('/audit', asyncHandler(async (req, res) => {
  const events = await prisma.auditEvent.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ events: events.map((e) => ({ id: e.id, actorId: e.actorId, actorType: e.actorType, action: e.action, entityType: e.entityType, entityId: e.entityId, createdAt: e.createdAt })) });
}));

// Model execution log (FR-045 traceability)
adminRouter.get('/model-executions', requireRole('admin'), asyncHandler(async (req, res) => {
  // ModelExecution carries only a sessionId, so scope through this tenant's
  // sessions. Without this the endpoint returned every tenant's executions,
  // exposing other tenants' session ids.
  const sessions = await prisma.interviewSession.findMany({
    where: { tenantId: req.auth!.tenantId }, select: { id: true },
  });
  const rows = await prisma.modelExecution.findMany({
    where: { sessionId: { in: sessions.map((s) => s.id) } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json({ executions: rows.map((r) => ({ id: r.id, provider: r.provider, model: r.model, function: r.function, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, createdAt: r.createdAt })) });
}));

// Analytics (FR-042) — funnel, reliability, overrides, fairness (min group size)
adminRouter.get('/analytics', asyncHandler(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const [roles, candidates, sessions, assessments, reviews] = await Promise.all([
    prisma.role.count({ where: { tenantId } }),
    prisma.candidate.count({ where: { tenantId } }),
    prisma.interviewSession.findMany({ where: { tenantId }, select: { state: true } }),
    prisma.assessmentVersion.findMany({ where: { session: { tenantId } }, select: { recommendation: true, evidenceCoverage: true, confidence: true } }),
    prisma.humanReview.findMany({ where: { assessment: { session: { tenantId } } }, select: { disposition: true } }),
  ]);
  const stateCounts: Record<string, number> = {};
  for (const s of sessions) stateCounts[s.state] = (stateCounts[s.state] ?? 0) + 1;
  const recCounts: Record<string, number> = {};
  for (const a of assessments) recCounts[a.recommendation] = (recCounts[a.recommendation] ?? 0) + 1;
  const avgCoverage = assessments.length ? assessments.reduce((x, a) => x + a.evidenceCoverage, 0) / assessments.length : 0;
  const completed = sessions.filter((s) => ['REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED'].includes(s.state)).length;
  res.json({
    funnel: { roles, candidates, interviews: sessions.length, completed },
    stateCounts, recommendations: recCounts, reviews: reviews.length,
    quality: { avgEvidenceCoverage: Math.round(avgCoverage * 100) / 100 },
    fairnessNote: 'Selection-rate monitoring requires a configured minimum group size and lawful group attributes; not computed on this dataset.',
  });
}));

// Webhook endpoints CRUD (FR-039)
adminRouter.get('/webhooks', asyncHandler(async (req, res) => {
  const hooks = await prisma.webhookEndpoint.findMany({ where: { tenantId: req.auth!.tenantId } });
  res.json({ webhooks: hooks });
}));
adminRouter.post('/webhooks', requireRole('admin'), asyncHandler(async (req, res) => {
  const body = z.object({ url: z.string().url(), events: z.string().default('*') }).parse(req.body);
  const hook = await prisma.webhookEndpoint.create({ data: { tenantId: req.auth!.tenantId, url: body.url, events: body.events } });
  res.status(201).json({ webhook: hook });
}));

// Tenant policy (retention, disclosure, recording default)
adminRouter.get('/policy', asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  res.json({ policy: parseJson(tenant?.policyJson ?? '{}', {}) });
}));
adminRouter.put('/policy', requireRole('admin'), asyncHandler(async (req, res) => {
  const policy = req.body?.policy ?? {};
  await prisma.tenant.update({ where: { id: req.auth!.tenantId }, data: { policyJson: JSON.stringify(policy) } });
  res.json({ policy });
}));
