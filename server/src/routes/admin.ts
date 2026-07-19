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
import { findSessionsDueForPurge, retentionDays, DEFAULT_RETENTION_DAYS } from '../services/dataRights.js';
import { logAudit } from '../services/audit.js';

export const adminRouter = Router();
adminRouter.use(authenticate);

// Ceiling on how far an admin may push a single session's retention. 7 years
// covers the longest ordinary employment-records obligation an HR team is likely
// to face; anything beyond it is a preservation decision that should be recorded
// as a legal hold, not buried in a timestamp nobody reviews.
const MAX_RETENTION_EXTENSION_DAYS = 365 * 7;

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

// Retention dry-run (GDPR Art. 5(1)(e) / DPDP s.8(6) storage limitation).
//
// Deleting a real candidate's interview must never be a silent surprise, so the
// sweep is inspectable before it runs. This is read-only: it deletes nothing and
// is built on the same query the sweep uses, so the preview cannot disagree with
// what actually happens. Scoped to the caller's tenant.
adminRouter.get('/retention/preview', requireRole('admin'), asyncHandler(async (req, res) => {
  const query = z.object({ asOf: z.string().datetime().optional() }).parse(req.query);
  // asOf lets an admin ask "what falls out of retention next month?" as well as
  // "what goes tonight?".
  const now = query.asOf ? new Date(query.asOf) : new Date();
  const due = await findSessionsDueForPurge({ now, tenantId: req.auth!.tenantId });

  // The response lists candidates by name, so pulling it is itself an access to
  // personal data. Every other sensitive action on this router is audited; an
  // unlogged bulk enumeration would leave "who listed the candidates about to be
  // deleted" unanswerable. Counts only — no names in the audit record.
  await logAudit({
    tenantId: req.auth!.tenantId,
    actorType: 'user',
    actorId: req.auth!.userId,
    action: 'retention.previewed',
    entityType: 'InterviewSession',
    after: { asOf: now.toISOString(), dueCount: due.length },
  });

  res.json({
    asOf: now.toISOString(),
    defaultRetentionDays: retentionDays(),
    defaultRetentionDaysBuiltIn: DEFAULT_RETENTION_DAYS,
    dueCount: due.length,
    totals: due.reduce((acc, d) => ({
      turns: acc.turns + d.counts.turns,
      assessments: acc.assessments + d.counts.assessments,
      artifacts: acc.artifacts + d.counts.artifacts,
    }), { turns: 0, assessments: 0, artifacts: 0 }),
    sessions: due.map((d) => ({
      sessionId: d.sessionId,
      candidateId: d.candidateId,
      candidateName: d.candidateName,
      state: d.state,
      createdAt: d.createdAt,
      completedAt: d.completedAt,
      retainUntil: d.retainUntil,
      usingDefaultWindow: d.usingDefaultWindow,
      counts: d.counts,
    })),
  });
}));

// Set a legal hold or an explicit retention date on one session. Without this
// the schema's legalHold flag would be unreachable, and a hold you cannot apply
// is not a hold. Admin-only, tenant-scoped, and audit-logged because extending
// retention is itself a decision a regulator may ask you to justify.
adminRouter.patch('/retention/sessions/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const body = z.object({
    legalHold: z.boolean().optional(),
    retainUntil: z.string().datetime().nullable().optional(),
  }).parse(req.body);

  const session = await prisma.interviewSession.findFirst({
    where: { id: req.params.id, tenantId: req.auth!.tenantId },
    select: { id: true, legalHold: true, retainUntil: true },
  });
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

  // An unbounded retainUntil ("9999-12-31") is indefinite retention wearing a
  // date, reachable through a supported endpoint — the exact outcome storage
  // limitation forbids. Cap extensions at MAX_RETENTION_EXTENSION_DAYS; genuinely
  // longer preservation belongs under legalHold, which is visible as a hold
  // rather than hidden in a far-future timestamp.
  if (body.retainUntil) {
    const requested = new Date(body.retainUntil);
    const ceiling = new Date(Date.now() + MAX_RETENTION_EXTENSION_DAYS * 86_400_000);
    if (requested > ceiling) {
      res.status(400).json({
        error: `retainUntil may not exceed ${MAX_RETENTION_EXTENSION_DAYS} days from now; use legalHold for longer preservation`,
      });
      return;
    }
  }

  const updated = await prisma.interviewSession.update({
    where: { id: session.id },
    data: {
      ...(body.legalHold !== undefined ? { legalHold: body.legalHold } : {}),
      ...(body.retainUntil !== undefined
        ? { retainUntil: body.retainUntil === null ? null : new Date(body.retainUntil) }
        : {}),
    },
    select: { id: true, legalHold: true, retainUntil: true },
  });

  await logAudit({
    tenantId: req.auth!.tenantId,
    actorType: 'user',
    actorId: req.auth!.userId,
    action: 'session.retention_updated',
    entityType: 'InterviewSession',
    entityId: session.id,
    before: { legalHold: session.legalHold, retainUntil: session.retainUntil },
    after: { legalHold: updated.legalHold, retainUntil: updated.retainUntil },
  });

  res.json({ session: updated });
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
