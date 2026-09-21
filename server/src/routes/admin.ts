import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, parseJsonStrict, parseJsonOptional } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { isPlatformOperator, isReservedOperatorEmail } from '../middleware/platformOperator.js';
import { config } from '../config.js';
import { hashPassword } from '../services/auth.js';
import { findUserByEmail, normalizeEmail } from '../services/userEmail.js';
import { isKnownTimeZone } from '../services/roundTime.js';
import { capabilitiesOf, isRoleName, ROLES } from '../domain/capabilities.js';
import { assignRole, assignCandidate, candidateScope } from '../services/access.js';
import { sttCapability, ttsCapability } from '../providers/speech.js';
import { getLlm } from '../providers/llm/index.js';
import { getEmail } from '../providers/email/index.js';
import { findConnection, tenantAtsReady } from '../services/atsConnections.js';
import { isOperator, requireOperator as operatorOnly } from '../middleware/operator.js';
import { allMeetingCapabilities } from '../providers/meeting/index.js';
import { roundMeetingStatus } from '../providers/meeting/roundMeetings.js';
import { ROUND_MEETING_PROVIDERS } from '../providers/meeting/types.js';
import { findSessionsDueForPurge, retentionDays, DEFAULT_RETENTION_DAYS } from '../services/dataRights.js';
import { logAudit } from '../services/audit.js';
import { getAgreementReport, DISPOSITIONS } from '../services/shadowMode.js';
import { getPipelineSummary } from '../services/pipeline.js';
import { ORG_SLUG } from './orgs.js';
import { decideSignupRequest, signupApplicant } from '../services/signup.js';
import { webhookUrlProblem } from '../services/webhookUrl.js';
import { resolveCommit } from '../services/build.js';
import { INSTANCE_ID, latestJobRuns } from '../services/jobs.js';
import { legacySignatureStatus, webhookHealth } from '../services/webhooks.js';

export const adminRouter = Router();
adminRouter.use(authenticate);

// Ceiling on how far an admin may push a single session's retention. 7 years
// covers the longest ordinary employment-records obligation an HR team is likely
// to face; anything beyond it is a preservation decision that should be recorded
// as a legal hold, not buried in a timestamp nobody reviews.
const MAX_RETENTION_EXTENSION_DAYS = 365 * 7;

// Provider / connector status — shows which paid components are plugged in.
//
// Admin-only. Which external systems a deployment is wired to, and which of
// them are configured, is operations detail: a recruiter has no workflow that
// needs it, and the answer describes the whole deployment rather than their
// tenant. Only the Admin console reads this.
adminRouter.get('/providers', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const llm = getLlm();
  const showEnv = capabilitiesOf(req.auth!.role).includes('admin:manage');
  const meeting = allMeetingCapabilities().map(({ env, ...rest }) => (showEnv ? { ...rest, env } : rest));
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { policyJson: true } });
  // Who creates links for human rounds in this organisation, and whether it can.
  const roundMeeting = roundMeetingStatus(parseJsonOptional<Record<string, unknown>>(tenant?.policyJson, {}, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' }), { includeEnv: showEnv });
  res.json({
    llm: { provider: llm.name, enabled: llm.enabled, configured: llm.enabled, mode: llm.enabled ? 'remote' : 'built-in heuristic' },
    stt: sttCapability(),
    tts: ttsCapability(),
    email: { provider: getEmail().name, configured: getEmail().configured },
    // This organisation's own ATS, not a deployment-wide one.
    ats: { provider: (await findConnection(req.auth!.tenantId))?.provider ?? 'none', configured: await tenantAtsReady(req.auth!.tenantId) },
    meeting,
    // Meeting connection tests use the deployment's shared vendor apps, so only
    // the operator may run them; the console greys the button for everyone else.
    canTestMeetingConnectors: isOperator(req.auth),
    roundMeeting,
    build: { commit: resolveCommit() },
  });
}));


// Operations view: is the background machinery alive, and is anything failing
// quietly? Everything here used to be answerable only by reading logs.
//
// The operator's alone. Every figure spans the whole deployment (model calls,
// webhook deliveries and job failures for every organisation, with raw error
// text), and `admin:manage` alone showed all of it to the admin of any
// customer. /api/admin/health is the per-organisation view.
const requireOpsOperator = operatorOnly({
  forbidden: 'Only the deployment operator can see the operations view.',
  unconfigured: 'The operations view is not available on this deployment.',
});

adminRouter.get('/ops', requireCapability('admin:manage'), requireOpsOperator, asyncHandler(async (req, res) => {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);
  const [jobs, webhooks, legacySignature, modelCalls, modelFailures] = await Promise.all([
    latestJobRuns(),
    webhookHealth(),
    // How many webhooks still get the retired v1 signature, so the owner can
    // see when WEBHOOK_V1_SIGNATURE=off would break nobody.
    legacySignatureStatus(),
    prisma.modelExecution.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.modelExecution.count({ where: { createdAt: { gte: dayAgo }, safetyJson: { contains: '"error"' } } }),
  ]);
  res.json({
    build: { commit: resolveCommit() },
    instance: INSTANCE_ID,
    uptimeSeconds: Math.round(process.uptime()),
    retentionSweepEnabled: process.env.RETENTION_SWEEP_ENABLED === 'true',
    jobs,
    webhooks: { ...webhooks, legacySignature },
    model: { last24h: { calls: modelCalls, failures: modelFailures } },
  });
}));

// Operator-approved signup queue. These rows intentionally sit outside any
// tenant until approval; the deployment operator, not a tenant-scoped recruiter,
// is deciding whether an account should exist at all.
const signupStatusSchema = z.object({
  status: z.enum(['pending', 'approved', 'declined', 'expired']).optional().default('pending'),
}).strict();

/**
 * The queue is the operator's, not every tenant admin's. `admin:manage` alone
 * let the admin of any customer read every applicant in the deployment, approve
 * a join request into another customer's organisation, or decline everyone
 * else's applicants. The operator is whoever the decision emails go to; with no
 * approver configured the queue, like signup itself, fails closed.
 */
const requireOperator = operatorOnly({
  forbidden: 'Only the deployment operator can review account requests.',
  unconfigured: 'Signup is temporarily unavailable.',
});

adminRouter.get('/signups', requireCapability('admin:manage'), requireOperator, asyncHandler(async (req, res) => {
  const query = signupStatusSchema.parse(req.query);
  const rows = await prisma.signupRequest.findMany({
    where: { status: query.status.toUpperCase() },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, name: true, email: true, mode: true, organisationName: true, orgSlug: true,
      status: true, expiresAt: true, decidedAt: true, decidedBy: true, createdTenantId: true, createdUserId: true, createdAt: true,
    },
  });
  res.json({ signups: rows.map((row) => ({ ...row, applicant: signupApplicant(row as never) })) });
}));

adminRouter.post('/signups/:id/approve', requireCapability('admin:manage'), requireOperator, asyncHandler(async (req, res) => {
  const { transitioned } = await decideSignupRequest({ id: req.params.id, decision: 'approve', actorId: req.auth!.userId });
  if (!transitioned) throw new HttpError(409, 'This request has already been decided.');
  res.json({ recorded: true });
}));

adminRouter.post('/signups/:id/decline', requireCapability('admin:manage'), requireOperator, asyncHandler(async (req, res) => {
  const { transitioned } = await decideSignupRequest({ id: req.params.id, decision: 'decline', actorId: req.auth!.userId });
  if (!transitioned) throw new HttpError(409, 'This request has already been decided.');
  res.json({ recorded: true });
}));

// Audit log (FR-038)
//
// Was readable by any authenticated user in the tenant. The audit trail names
// who acted on which entity id and when — a recruiter could enumerate every
// candidate id in the tenant from it without ever being assigned one, which is
// precisely the disclosure object scoping exists to close.
const auditQuerySchema = z.object({
  action: z.string().min(1).max(100).optional(),
  actorId: z.string().min(1).max(100).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

adminRouter.get('/audit', requireCapability('audit:read'), asyncHandler(async (req, res) => {
  const query = auditQuerySchema.parse(req.query);
  const tenantId = req.auth!.tenantId;
  const where: Prisma.AuditEventWhereInput = {
    tenantId,
    ...(query.action ? { action: query.action } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.from || query.to
      ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } }
      : {}),
  };

  const total = await prisma.auditEvent.count({ where });
  const skip = (query.page - 1) * query.limit;
  const [events, actionRows, actorRows] = await Promise.all([
    // Past the last page there is nothing to read: asking the database to sort
    // the tenant's whole history and discard it costs the same as reading it.
    skip >= total
      ? Promise.resolve([])
      : prisma.auditEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take: query.limit }),
    // Filter options are tenant-wide (not narrowed by the current filter) so
    // choosing one action does not make every other option disappear. They are
    // the same on every page, so they are built once, for the first one.
    query.page === 1 ? prisma.auditEvent.groupBy({ by: ['action'], where: { tenantId }, orderBy: { action: 'asc' } }) : Promise.resolve([]),
    query.page === 1 ? prisma.auditEvent.groupBy({ by: ['actorId', 'actorType'], where: { tenantId } }) : Promise.resolve([]),
  ]);

  // Names only for users in THIS tenant; an actorId that is not one of them
  // (system, model, a deleted user) falls back to the raw id. Resolved from the
  // events actually on this page as well as the filter options, because the
  // options are only built for page 1 — reading them alone left every event
  // after the first page with no actor name.
  const actorIds = [...new Set([...actorRows.map((a) => a.actorId), ...events.map((e) => e.actorId)])];
  const users = await prisma.user.findMany({
    where: { tenantId, id: { in: actorIds } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const actors = [...new Map(actorRows.map((a) => [a.actorId, {
    id: a.actorId, type: a.actorType, name: nameOf.get(a.actorId) ?? a.actorId,
  }])).values()].sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    events: events.map((e) => ({
      id: e.id, actorId: e.actorId, actorType: e.actorType, actorName: nameOf.get(e.actorId) ?? null,
      action: e.action, entityType: e.entityType, entityId: e.entityId, createdAt: e.createdAt,
    })),
    meta: { total, page: query.page, limit: query.limit },
    filters: { actions: actionRows.map((a) => a.action), actors },
  });
}));

// Model execution log (FR-045 traceability)
adminRouter.get('/model-executions', requireCapability('audit:read'), asyncHandler(async (req, res) => {
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
//
// Gated on `assessment:read` rather than `audit:read`. The payload is dominated
// by assessment substance — recommendation distribution, evidence coverage,
// review counts — so the right gate is the capability whose holders already see
// assessment content. `audit:read` would be the wrong choice: the auditor role
// is deliberately scoped to "sees that things happened, not candidate detail",
// and handing auditors the recommendation mix would quietly widen that role past
// its design.
//
// KNOWN RESIDUAL: these figures stay tenant-wide aggregates, not object-scoped,
// so an assigned recruiter still learns the tenant's total headcount funnel.
// That is an aggregate-disclosure decision, not an id disclosure, and closing it
// means deciding a k-anonymity floor — out of scope here, but recorded so it is
// not mistaken for an oversight.
adminRouter.get('/analytics', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
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

// HR feedback dashboard — one read-only call that composes the three signals
// an HR reviewer otherwise has to know to fetch separately:
//   - pipeline: session counts by state, via the same scoped aggregation
//     GET /api/interviews/pipeline-summary uses (services/pipeline.ts).
//   - agreement: the blind-review-vs-AI agreement report, via the SAME
//     getAgreementReport function GET /api/assessments/shadow-metrics calls.
//     That function is tenant-wide by design (see shadowMode.ts) — reused
//     as-is, not re-scoped, so this does not invent a second definition of
//     "how shadow metrics are scoped".
//   - reviewDispositions: a PROCEED/CONSIDER/DO_NOT_PROGRESS rollup over
//     HumanReview, scoped through candidateScope like every other
//     candidate-scoped query (services/access.ts).
//
// Gated on `assessment:read`, matching GET /analytics just above: the payload
// is dominated by assessment/review substance, and that is the capability
// already held by the roles who see that kind of content.
//
// This is purely a read-side composition — no scoring, no HumanReview writes,
// no schema changes.
adminRouter.get('/hr-dashboard', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const auth = req.auth!;
  const candScope = (await candidateScope(auth)) as Prisma.CandidateWhereInput;

  const [pipeline, agreement, dispositionRows] = await Promise.all([
    getPipelineSummary(auth),
    getAgreementReport(auth.tenantId),
    prisma.humanReview.groupBy({
      by: ['disposition'],
      where: { assessment: { session: { tenantId: auth.tenantId, candidate: candScope } } },
      _count: { _all: true },
    }),
  ]);

  const reviewDispositions: Record<(typeof DISPOSITIONS)[number], number> = {
    PROCEED: 0, CONSIDER: 0, DO_NOT_PROGRESS: 0,
  };
  for (const row of dispositionRows) {
    if ((DISPOSITIONS as readonly string[]).includes(row.disposition)) {
      reviewDispositions[row.disposition as (typeof DISPOSITIONS)[number]] = row._count._all;
    }
  }

  res.json({ pipeline, agreement, reviewDispositions });
}));

// Organisation sign-in link (/o/:slug). The slug is what an organisation shares
// with its HR team; login through that link is then held to this organisation.
const orgSlugSchema = z.object({
  slug: z.string().regex(ORG_SLUG, 'Use 2–40 lowercase letters, numbers or hyphens, starting and ending with a letter or number.'),
});

adminRouter.patch('/org', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const { slug } = orgSlugSchema.parse(req.body);
  const tenantId = req.auth!.tenantId;

  const taken = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
  if (taken && taken.id !== tenantId) throw new HttpError(409, 'That organisation link is already in use.');

  const before = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  let org: { name: string; slug: string | null };
  try {
    org = await prisma.tenant.update({ where: { id: tenantId }, data: { slug }, select: { name: true, slug: true } });
  } catch (err) {
    // Two organisations claiming the same slug at once: the unique index decides.
    if ((err as { code?: string }).code === 'P2002') throw new HttpError(409, 'That organisation link is already in use.');
    throw err;
  }

  await logAudit({
    tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'org.slug_changed', entityType: 'Tenant', entityId: tenantId,
    before: { slug: before?.slug ?? null }, after: { slug },
  });
  res.json({ org });
}));

// Webhook endpoints CRUD (FR-039)
//
// The read was ungated while the write was admin-only, which is backwards as a
// pair: a webhook row is a delivery URL, and those routinely embed a shared
// secret in the path or query. Any tenant user could read them and then receive
// (or replay to) the tenant's outbound event stream.
adminRouter.get('/webhooks', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const hooks = await prisma.webhookEndpoint.findMany({ where: { tenantId: req.auth!.tenantId } });
  // The console shows each webhook's v1 setting as moot while the operator's
  // switch has v1 off everywhere.
  res.json({ webhooks: hooks, legacySignatureDisabledEverywhere: config.webhookV1Signature === 'off' });
}));
adminRouter.post('/webhooks', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const body = z.object({ url: z.string().trim().max(2000), events: z.string().trim().max(500).default('*') }).parse(req.body);
  // `z.string().url()` accepted any host. The server POSTs a signed body to
  // this address, so a loopback or metadata address here is a request the
  // server makes against itself or its network on an admin's say-so.
  const problem = webhookUrlProblem(body.url, config.nodeEnv);
  if (problem) throw new HttpError(400, problem);
  const hook = await prisma.webhookEndpoint.create({ data: { tenantId: req.auth!.tenantId, url: body.url, events: body.events } });
  // Host only: a delivery URL routinely carries a shared secret in its path.
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'webhook.created', entityType: 'WebhookEndpoint', entityId: hook.id, after: { host: new URL(hook.url).host, events: hook.events } });
  res.status(201).json({ webhook: hook });
}));
// The only field that can change in place. Everything else about a webhook is
// its destination, and a destination change goes through delete and create so
// it passes the address checks and is audited as what it is.
const webhookPatchSchema = z.object({ sendLegacySignature: z.boolean() }).strict();
adminRouter.patch('/webhooks/:id', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const body = webhookPatchSchema.parse(req.body);
  const tenantId = req.auth!.tenantId;
  const before = await prisma.webhookEndpoint.findFirst({ where: { id: req.params.id, tenantId } });
  if (!before) throw new HttpError(404, 'Webhook not found');
  const hook = await prisma.webhookEndpoint.update({ where: { id: before.id }, data: { sendLegacySignature: body.sendLegacySignature } });
  // Switching v1 off is what breaks a receiver that never moved to v2, so the
  // record of who did it and when is what the first support call needs.
  await logAudit({
    tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'webhook.legacy_signature.changed',
    entityType: 'WebhookEndpoint', entityId: hook.id,
    before: { sendLegacySignature: before.sendLegacySignature },
    after: { host: new URL(hook.url).host, sendLegacySignature: hook.sendLegacySignature },
  });
  res.json({ webhook: hook });
}));
adminRouter.delete('/webhooks/:id', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const { count } = await prisma.webhookEndpoint.deleteMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId } });
  if (count === 0) throw new HttpError(404, 'Webhook not found');
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'webhook.deleted', entityType: 'WebhookEndpoint', entityId: req.params.id });
  res.json({ ok: true });
}));

// Retention dry-run (GDPR Art. 5(1)(e) / DPDP s.8(6) storage limitation).
//
// Deleting a real candidate's interview must never be a silent surprise, so the
// sweep is inspectable before it runs. This is read-only: it deletes nothing and
// is built on the same query the sweep uses, so the preview cannot disagree with
// what actually happens. Scoped to the caller's tenant.
adminRouter.get('/retention/preview', requireCapability('retention:configure'), asyncHandler(async (req, res) => {
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
adminRouter.patch('/retention/sessions/:id', requireCapability('retention:configure'), asyncHandler(async (req, res) => {
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
//
// Read-gated to match the write. The policy blob states the retention windows,
// the recording default and whether human review is required — i.e. exactly
// which safeguards are switched off. That is a reconnaissance document for
// anyone probing the tenant, and it is not needed to do recruiting work: the
// disclosure text a candidate must see is served separately by the portal.
adminRouter.get('/policy', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  // An admin shown {} would read every safeguard as off and "restore" them.
  res.json({ policy: tenant ? parseJsonStrict(tenant.policyJson, { model: 'Tenant', id: tenant.id, field: 'policyJson' }) : {} });
}));
// The policy is the candidate-facing consent notice and the switches for
// proctoring, candidate feedback and human review. This route used to take
// whatever was posted, replace the whole blob with it, and record nothing: a
// body with no `policy` reset every safeguard to off and answered 200, and
// "who weakened the disclosure, and when" had no answer. Keys are bounded,
// unknown ones refused, the disclosure may not be blank, changes merge, and
// before/after go to the audit log.
const policySchema = z.object({
  disclosureText: z.string().trim().min(1).max(4000).optional(),
  requireHumanReview: z.boolean().optional(),
  candidateFeedbackEnabled: z.boolean().optional(),
  // Email every candidate who completes an interview their feedback,
  // automatically. Unset means on (services/autoFeedbackModel.ts).
  autoCandidateFeedback: z.boolean().optional(),
  // Reviewers must judge blind before the assessment opens. Unset means off.
  requireBlindReview: z.boolean().optional(),
  // Hours the hiring team has to complete a review before the candidate's
  // feedback goes on its own. Unset means the deployment default (12).
  feedbackReviewWindowHours: z.number().int().min(0).max(168).optional(),
  // Sign the candidate's feedback as this organisation's hiring team instead
  // of as Questor. Unset means Questor.
  feedbackSignedByCompany: z.boolean().optional(),
  proctoringEnabled: z.boolean().optional(),
  recordingDefault: z.boolean().optional(),
  // Which provider creates meeting links for human rounds. Credentials stay
  // deployment-wide in server/.env; this only chooses among them.
  roundMeetingProvider: z.enum(ROUND_MEETING_PROVIDERS).optional(),
  // IANA zone the organisation works in (e.g. "Asia/Kolkata"); times in
  // scheduling emails are stated in it.
  timeZone: z.string().trim().max(64).refine(isKnownTimeZone, 'Use an IANA time zone such as "Asia/Kolkata".').optional(),
}).strict();

adminRouter.put('/policy', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const patch = z.object({ policy: policySchema }).strict().parse(req.body).policy;
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.auth!.tenantId }, select: { policyJson: true } });
  // Merging onto {} would save the patch alone as the whole policy.
  const before = parseJsonStrict<Record<string, unknown>>(tenant.policyJson, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' });
  const policy = { ...before, ...patch };
  await prisma.tenant.update({ where: { id: req.auth!.tenantId }, data: { policyJson: JSON.stringify(policy) } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'tenant.policy.updated', entityType: 'Tenant', entityId: req.auth!.tenantId, before, after: policy });
  res.json({ policy });
}));

// ---------------------------------------------------------------------------
// User + assignment management (admin:manage)
//
// Object scoping is only half a design without this half. `/api/auth/register`
// deliberately mints exactly one user — the first admin of a new tenant — and
// refuses to take `role` from the body, so before these endpoints existed a
// tenant physically could not have a second user. Turning on scoping in that
// world would have made every object admin-only forever, and the predictable
// escape hatch would have been "make everyone an admin", which is scoping
// deleted while appearing to be present.
//
// Every id below is re-read under the caller's tenantId before it is used. An
// admin is tenant-wide, not global: without that re-read, `POST
// /users/:id/candidates/:candidateId` would happily bind a foreign tenant's
// candidate to a local user and silently create a cross-tenant read channel.
// ---------------------------------------------------------------------------

// passwordHash must never leave the server; naming the columns explicitly means
// a future column addition cannot leak by default the way `select: undefined`
// would.
const USER_FIELDS = { id: true, email: true, name: true, role: true, createdAt: true } as const;

/** Load a user by id, but only if they belong to the caller's tenant. */
async function tenantUser(tenantId: string, userId: string) {
  const user = await prisma.user.findFirst({ where: { id: userId, tenantId }, select: USER_FIELDS });
  // 404 rather than 403, matching services/access.ts: distinguishing "not yours"
  // from "does not exist" confirms the id to a caller who should not have it.
  if (!user) throw new HttpError(404, 'User not found');
  return user;
}

adminRouter.get('/users', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.auth!.tenantId }, select: USER_FIELDS, orderBy: { createdAt: 'asc' },
  });
  res.json({ users });
}));

// z.enum over ROLES rather than a free string: an unrecognised role resolves to
// NO capabilities, so a typo'd "recruter" would create an account that is not
// broken loudly but silently powerless, and the admin would debug it as a bug in
// permissions rather than as their own typo.
const roleNameSchema = z.enum(ROLES);

const createUserSchema = z.object({
  email: z.string().trim().email().transform(normalizeEmail),
  // Mirrors the 12-character floor in /api/auth/register. An admin-created
  // account is a real login; letting it be weaker than a self-registered one
  // would make the admin path the soft target.
  password: z.string().min(12, 'Password must be at least 12 characters'),
  name: z.string().min(1),
  role: roleNameSchema,
});

adminRouter.post('/users', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const body = createUserSchema.parse(req.body);
  // User.email is globally unique, not per-tenant, so this collides across
  // tenants too. Reporting only "already registered" is intentional: echoing
  // which tenant holds it would confirm that address to an outsider.
  // Case-insensitive, so a mixed-case row stored before normalisation still
  // counts as the same mailbox.
  if (await findUserByEmail(body.email)) throw new HttpError(409, 'Email already registered');
  // An account for a platform-owner address makes its holder the owner. Only
  // an owner may create one; to anyone else it looks like any taken address.
  if (isReservedOperatorEmail(body.email) && !isPlatformOperator(req.auth)) throw new HttpError(409, 'Email already registered');

  const user = await prisma.user.create({
    data: {
      tenantId: req.auth!.tenantId,
      email: body.email,
      name: body.name,
      passwordHash: hashPassword(body.password),
      role: body.role,
    },
    select: USER_FIELDS,
  });

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'user.created', entityType: 'User', entityId: user.id,
    after: { email: user.email, role: user.role },
  });

  res.status(201).json({ user });
}));

adminRouter.patch('/users/:id/role', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const { role } = z.object({ role: roleNameSchema }).parse(req.body);
  const target = await tenantUser(req.auth!.tenantId, req.params.id);

  // Demoting the last admin locks the tenant out of user management, retention
  // and policy permanently — nothing else can grant admin:manage back, so
  // recovery would mean direct database surgery. Cheaper to refuse.
  //
  // Count and write in one serialised transaction: two admins demoting each
  // other at once both counted two admins, both passed, and left none.
  const updated = await prisma.$transaction(async (tx) => {
    if (target.role === 'admin' && role !== 'admin') {
      // Serializable is what makes the count trustworthy: on Postgres two
      // concurrent demotions conflict and one is aborted (P2034, answered as
      // 409 below); SQLite serialises write transactions outright.
      const demoted = await tx.user.updateMany({ where: { id: target.id, role: 'admin' }, data: { role } });
      const remaining = await tx.user.count({ where: { tenantId: req.auth!.tenantId, role: 'admin' } });
      if (demoted.count !== 1 || remaining < 1) throw new HttpError(409, 'Cannot remove the last admin; promote another user first');
    }
    return tx.user.update({ where: { id: target.id }, data: { role }, select: USER_FIELDS });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((err: unknown) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new HttpError(409, 'Another role change for this organisation happened at the same moment. Try again.');
    }
    throw err;
  });

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'user.role_changed', entityType: 'User', entityId: target.id,
    before: { role: target.role }, after: { role: updated.role },
  });

  // HTTP requests re-read the role from the database on every call (see
  // authenticate), so the change applies on the user's next request. The live
  // interview socket still checks the role inside the token it connected with,
  // which is why that caveat is stated rather than claiming instant effect.
  res.json({ user: updated, note: 'The new role applies from the user\'s next request. A live interview connection they already have open keeps the old role until their sign-in expires.' });
}));

// Assignments. Deliberately separate from the role change above: what a user MAY
// DO (capability, via their role) and WHAT they may do it TO (scope, via these
// rows) are different questions, and collapsing them is how "reviewer" turns
// into "reviewer of everything".
const relationSchema = z.object({ relation: z.string().min(1).max(32).optional() });

adminRouter.post('/users/:id/roles/:roleId', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const { relation } = relationSchema.parse(req.body ?? {});
  const tenantId = req.auth!.tenantId;
  const user = await tenantUser(tenantId, req.params.id);
  const role = await prisma.role.findFirst({ where: { id: req.params.roleId, tenantId }, select: { id: true } });
  if (!role) throw new HttpError(404, 'Role not found');

  const assignment = await assignRole(role.id, user.id, relation ?? 'owner');
  await logAudit({
    tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'role.assigned', entityType: 'Role', entityId: role.id,
    after: { userId: user.id, relation: assignment.relation },
  });
  res.status(201).json({ assignment });
}));

adminRouter.delete('/users/:id/roles/:roleId', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const user = await tenantUser(tenantId, req.params.id);
  const role = await prisma.role.findFirst({ where: { id: req.params.roleId, tenantId }, select: { id: true } });
  if (!role) throw new HttpError(404, 'Role not found');

  // deleteMany, not delete: revoking a grant that is already absent is the
  // outcome the caller asked for, so it should not 500 on a missing row.
  const { count } = await prisma.roleAssignment.deleteMany({ where: { roleId: role.id, userId: user.id } });
  if (count > 0) {
    await logAudit({
      tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'role.unassigned', entityType: 'Role', entityId: role.id,
      before: { userId: user.id },
    });
  }
  res.json({ removed: count });
}));

adminRouter.post('/users/:id/candidates/:candidateId', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const { relation } = relationSchema.parse(req.body ?? {});
  const tenantId = req.auth!.tenantId;
  const user = await tenantUser(tenantId, req.params.id);
  const candidate = await prisma.candidate.findFirst({ where: { id: req.params.candidateId, tenantId }, select: { id: true } });
  if (!candidate) throw new HttpError(404, 'Candidate not found');

  const assignment = await assignCandidate(candidate.id, user.id, relation ?? 'owner');
  // Granting access to a named person is itself processing of their data, and is
  // the record that answers "who was able to see this candidate, and since when".
  await logAudit({
    tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'candidate.assigned', entityType: 'Candidate', entityId: candidate.id,
    after: { userId: user.id, relation: assignment.relation },
  });
  res.status(201).json({ assignment });
}));

adminRouter.delete('/users/:id/candidates/:candidateId', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const user = await tenantUser(tenantId, req.params.id);
  const candidate = await prisma.candidate.findFirst({ where: { id: req.params.candidateId, tenantId }, select: { id: true } });
  if (!candidate) throw new HttpError(404, 'Candidate not found');

  const { count } = await prisma.candidateAssignment.deleteMany({ where: { candidateId: candidate.id, userId: user.id } });
  if (count > 0) {
    await logAudit({
      tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'candidate.unassigned', entityType: 'Candidate', entityId: candidate.id,
      before: { userId: user.id },
    });
  }
  res.json({ removed: count });
}));
