import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma, parseJsonStrict, parseJsonOptional } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { isPlatformOperator, isReservedOperatorEmail, requirePlatformOperator } from '../middleware/platformOperator.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { startPasswordResetRequest, requestPasswordReset, type RequestOutcome as ResetRequestOutcome } from '../services/passwordReset.js';
import { grantMfaBypass, BYPASS_WINDOW_MS } from '../services/signInCode.js';
import { revokeAllTrustedDevices } from '../services/trustedDevice.js';
import { config } from '../config.js';
import { hashPassword } from '../services/auth.js';
import { findUserByEmail, normalizeEmail } from '../services/userEmail.js';
import { isKnownTimeZone } from '../services/roundTime.js';
import { ASSURANCE_LEVELS, assuranceLevelOf, isSelectableLevel } from '../domain/identityAssurance.js';
import { capabilitiesOf, isRoleName, ROLES } from '../domain/capabilities.js';
import { passwordSchema } from '../domain/passwordPolicy.js';
import { MFA_POLICIES, mfaPolicyOf } from '../domain/mfaPolicy.js';
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
import { anonymisationEnabled, anonymiseAfterDays, findCandidatesDueForAnonymisation, DEFAULT_ANONYMISE_AFTER_DAYS } from '../services/anonymise.js';
import { logAudit } from '../services/audit.js';
import { getAgreementReport, DISPOSITIONS } from '../services/shadowMode.js';
import { getPipelineSummary } from '../services/pipeline.js';
import { ORG_SLUG } from './orgs.js';
import { decideSignupRequest, signupApplicant } from '../services/signup.js';
import { existingOrganisationMatch, organisationNameIndex } from '../services/signupAbuse.js';
import { getTenantBusinessAreas, listBusinessAreas, setBusinessAreaLimit, setTenantBusinessAreas, MAX_BUSINESS_AREA_LIMIT } from '../services/businessAreas.js';
import { orgSizeLabel } from '../domain/orgOnboarding.js';
import { webhookUrlProblem } from '../services/webhookUrl.js';
import { resolveCommit } from '../services/build.js';
import { INSTANCE_ID, latestJobRuns } from '../services/jobs.js';
import { legacySignatureStatus, webhookHealth } from '../services/webhooks.js';
import { LIBRARY_MODES, MAX_WINDOW_DAYS } from '../library/orgSettings.js';

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
    // `delivers` as well as `configured`: the console provider is perfectly
    // configured and sends nothing, and that is the difference between a
    // sign-in code arriving and every account under the policy being locked
    // out. Shown so the console can say so rather than leaving it to be found.
    email: { provider: getEmail().name, configured: getEmail().configured, delivers: getEmail().delivers },
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
    anonymisationEnabled: anonymisationEnabled(),
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
      regionCode: true, orgSize: true, businessAreasJson: true,
    },
  });

  // The request's own details, in front of the person deciding it. Approving
  // "an organisation" without seeing which areas of the shared catalog it
  // asked for is approving a blank.
  const areaSlugs = new Set(rows.flatMap((row) => parseJsonOptional<string[]>(row.businessAreasJson, [], { model: 'SignupRequest', id: row.id, field: 'businessAreasJson' })));
  const [areaNames, regionNames, orgNames] = await Promise.all([
    areaSlugs.size === 0 ? [] : prisma.catalogDomain.findMany({ where: { slug: { in: [...areaSlugs] } }, select: { slug: true, name: true } }),
    prisma.catalogRegion.findMany({ select: { code: true, name: true } }),
    // Once for the whole queue: the name match has to normalise both sides, so
    // per row it would be one read of every tenant per request waiting.
    organisationNameIndex(),
  ]);
  const areaName = new Map(areaNames.map((a) => [a.slug, a.name]));
  const regionName = new Map(regionNames.map((r) => [r.code, r.name]));

  const signups = rows.map((row) => {
    const slugs = parseJsonOptional<string[]>(row.businessAreasJson, [], { model: 'SignupRequest', id: row.id, field: 'businessAreasJson' });
    return {
      ...row,
      applicant: signupApplicant(row),
      region: row.regionCode ? { code: row.regionCode, name: regionName.get(row.regionCode) ?? row.regionCode } : null,
      orgSizeLabel: row.orgSize ? orgSizeLabel(row.orgSize) : null,
      businessAreas: slugs.map((slug) => ({ slug, name: areaName.get(slug) ?? slug })),
      // The one fact the public form must never confirm, shown to the only
      // person entitled to know it: an organisation of this name is already
      // here, so this may be a duplicate — or someone reaching for the name.
      existingOrganisation: row.organisationName ? existingOrganisationMatch(row.organisationName, orgNames) : null,
    };
  });
  res.json({ signups });
}));

// --- business areas ---------------------------------------------------------
//
// An organisation's areas are its own to change, within a limit only the
// platform owner may raise. Both sides audited: "who narrowed our catalog"
// and "who let them have eight" are the same question asked from two ends.

const businessAreasSchema = z.object({
  areas: z.array(z.string().trim().min(1).max(80)).max(MAX_BUSINESS_AREA_LIMIT),
}).strict();

adminRouter.get('/business-areas', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const [chosen, all] = await Promise.all([getTenantBusinessAreas(req.auth!.tenantId), listBusinessAreas()]);
  res.json({
    limit: chosen.limit,
    chosen: chosen.areas.map(({ slug, name }) => ({ slug, name })),
    available: all.map(({ slug, name, summary }) => ({ slug, name, summary })),
  });
}));

adminRouter.put('/business-areas', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const { areas } = businessAreasSchema.parse(req.body);
  const saved = await setTenantBusinessAreas({ tenantId: req.auth!.tenantId, slugs: areas, actorId: req.auth!.userId });
  res.json({ limit: saved.limit, chosen: saved.areas.map(({ slug, name }) => ({ slug, name })) });
}));

const businessAreaLimitSchema = z.object({
  limit: z.number().int().min(1).max(MAX_BUSINESS_AREA_LIMIT),
}).strict();

const requireLimitOperator = operatorOnly({
  forbidden: 'Only the deployment operator can change an organisation\'s business-area limit.',
  unconfigured: 'This is temporarily unavailable.',
});

/** Every organisation and where it stands against its limit, for the owner. */
adminRouter.get('/organisations', requireCapability('admin:manage'), requireLimitOperator, asyncHandler(async (_req, res) => {
  const tenants = await prisma.tenant.findMany({
    where: { isDemo: false },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, slug: true, region: true, businessAreaLimit: true, _count: { select: { businessAreas: true } } },
  });
  res.json({
    organisations: tenants.map((t) => ({
      id: t.id, name: t.name, slug: t.slug, region: t.region,
      businessAreaLimit: t.businessAreaLimit, businessAreaCount: t._count.businessAreas,
    })),
  });
}));

adminRouter.put('/organisations/:id/business-area-limit', requireCapability('admin:manage'), requireLimitOperator, asyncHandler(async (req, res) => {
  const { limit } = businessAreaLimitSchema.parse(req.body);
  const saved = await setBusinessAreaLimit({ tenantId: req.params.id, limit, actorId: req.auth!.userId });
  res.json({ limit: saved.limit });
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
    fairnessNote: 'Outcome statistics — the funnel, score distributions and how outcomes differ by interviewer, scorecard version, band, region and month — are on this console’s Analytics tab (GET /api/reports/outcomes). Selection-rate monitoring ACROSS GROUPS is still not computed: it requires lawful group attributes and a configured minimum group size, and Questor collects neither.',
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

// Anonymisation dry-run.
//
// The mirror of the retention preview above, for the deployment that keeps its
// interviews instead of deleting them. It matters more here than it does there,
// not less: a purge is obviously destructive and an anonymisation is quiet —
// the interview is still in the list afterwards, and only the person is gone —
// so an operator has to be able to see exactly who would be severed while it is
// still possible to stop. Read-only, built on the same query the sweep uses so
// the preview cannot disagree with what happens, and scoped to the caller's
// tenant.
adminRouter.get('/anonymisation/preview', requireCapability('retention:configure'), asyncHandler(async (req, res) => {
  const query = z.object({ asOf: z.string().datetime().optional() }).parse(req.query);
  const now = query.asOf ? new Date(query.asOf) : new Date();
  const due = await findCandidatesDueForAnonymisation({ now, tenantId: req.auth!.tenantId });

  // Listing candidates by name is itself an access to personal data, and this
  // list is specifically "the people about to stop being people here". Counts
  // only in the audit record, for the same reason as the retention preview.
  await logAudit({
    tenantId: req.auth!.tenantId,
    actorType: 'user',
    actorId: req.auth!.userId,
    action: 'anonymisation.previewed',
    entityType: 'Candidate',
    after: { asOf: now.toISOString(), dueCount: due.length },
  });

  res.json({
    asOf: now.toISOString(),
    enabled: anonymisationEnabled(),
    anonymiseAfterDays: anonymiseAfterDays(),
    anonymiseAfterDaysBuiltIn: DEFAULT_ANONYMISE_AFTER_DAYS,
    dueCount: due.length,
    totals: due.reduce((acc, d) => ({
      sessions: acc.sessions + d.counts.sessions,
      turns: acc.turns + d.counts.turns,
    }), { sessions: 0, turns: 0 }),
    // Stated in the response, not only in the docs: whoever turns this on
    // should read what it does and does not promise at the moment they do it.
    removes: 'name, email, phone and LinkedIn URL, wherever Questor holds them — including in the transcript. '
      + 'Files, the CV, the ATS link, certificates and invitations are deleted outright: they identify the person whatever is overwritten. '
      + 'Any accommodation request the candidate typed is removed rather than redacted, because there is no pattern for it.',
    keeps: 'the transcript, scores, competency reads, evidence spans and timings. '
      + 'The audit trail keeps every row — who did what, to which record, when — but the candidate’s own rows lose their before/after detail, '
      + 'which is the only way to be sure nothing they wrote about themselves survives there.',
    caveat: 'Third parties a candidate names in passing — a former employer, a manager — cannot be found this way and may remain. '
      + 'So can a spelling of the candidate’s own address that Questor does not hold: a plus-tagged address is matched without its tag, '
      + 'but dot-variants of the same mailbox (priyasharma@ for priya.sharma@) are not, because at most providers those are different people.',
    candidates: due.map((d) => ({
      candidateId: d.candidateId,
      candidateName: d.candidateName,
      lastInterviewAt: d.lastInterviewAt,
      anonymiseAfter: d.anonymiseAfter,
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
  // Role calibration (docs/plans/role-calibration.md): let the evaluator learn
  // from what this organisation's reviewers actually decided. Unset means off,
  // and the deployment switch (CALIBRATION_ENABLED) must be on as well.
  calibrationEnabled: z.boolean().optional(),
  // Contribute anonymised observations to the shared calibration. A separate,
  // explicit opt-in with its own consent text
  // (services/calibrationSettings.ts, GLOBAL_CONTRIBUTION_CONSENT): switching
  // calibration on does NOT switch this on. Unset means off.
  calibrationGlobalContribution: z.boolean().optional(),
  // How much evidence this organisation wants before a calibration applies.
  // Held inside the product's own bounds (domain/calibration.ts,
  // resolveThresholds): an organisation may ask for MORE evidence than the
  // default and can never ask for less than three distinct reviewers.
  calibrationMinObservations: z.number().int().min(5).max(10_000).optional(),
  calibrationMinReviewers: z.number().int().min(3).max(100).optional(),
  // Reviews one person must have completed before any pattern about them is
  // computed or shown (domain/reviewerPatterns.ts). Unset means 10.
  calibrationReviewerPatternMinReviews: z.number().int().min(5).max(1000).optional(),
  // AI-drafted suggestions in the product's text fields. Unset means on; false
  // turns every suggestion and every "tidy up" off, for organisations whose
  // policy forbids AI-generated text in hiring (services/fieldDraftPolicy.ts).
  // It does NOT govern the judgement-field boundary, which cannot be switched
  // on at all (domain/fieldDrafts.ts).
  aiFieldDrafts: z.boolean().optional(),
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
  // The Q&A library for this organisation (library/orgSettings.ts). Read only
  // while the deployment's LIBRARY_ENABLED is on; unset means off.
  questionLibrary: z.enum(LIBRARY_MODES).optional(),
  questionLibraryTrialPercent: z.number().int().min(0).max(100).optional(),
  questionLibraryWindowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).optional(),
  // Candidate identity assurance. Standard is the floor for every
  // organisation (owner decision 2026-09-22); Enhanced and Verified are not
  // built yet, so only Standard can be saved.
  identityAssuranceLevel: z.string().refine(isSelectableLevel, 'Only the Standard identity level is available. Enhanced and Verified are coming later.').optional(),
}).strict();

// The organisation's identity assurance level, with every level listed so
// Settings can show the ones not available yet.
adminRouter.get('/identity-assurance', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { policyJson: true } });
  const policy = parseJsonOptional<Record<string, unknown>>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' });
  res.json({ level: assuranceLevelOf(policy), levels: ASSURANCE_LEVELS });
}));

/**
 * How this organisation signs in: who has to enter a code, and whether the
 * organisation appears in the sign-in page's name search.
 *
 * Separate from PUT /policy because changing the code rule has to do one thing
 * that a policy merge cannot: bump the organisation's policy generation, which
 * is what retires every trusted device granted under the looser rule. Tightening
 * the policy and leaving a week of remembered devices standing would be the
 * change appearing to happen without happening.
 */
adminRouter.get('/signin-policy', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.auth!.tenantId }, select: { policyJson: true, listed: true } });
  const policy = parseJsonOptional<Record<string, unknown>>(tenant.policyJson, {}, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' });
  res.json({ mfaPolicy: mfaPolicyOf(policy), policies: MFA_POLICIES, listed: tenant.listed });
}));

const signInPolicySchema = z.object({
  mfaPolicy: z.enum(MFA_POLICIES).optional(),
  listed: z.boolean().optional(),
}).strict();

// Changing the code rule retires every remembered device in the organisation,
// so flipping it back and forth is a way for one admin to keep every colleague
// entering codes all day. Generous — an admin settling on a policy might save
// three or four times — and a ceiling on using it as a weapon.
const signInPolicyLimit = rateLimit({
  name: 'admin-signin-policy', windowMs: 60 * 60_000, max: 20,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

// Forgetting a colleague's devices is cheap for the admin and expensive for
// the colleague, who then enters a code on every device they own.
const revokeDevicesLimit = rateLimit({
  name: 'admin-revoke-devices', windowMs: 60 * 60_000, max: 30,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

adminRouter.put('/signin-policy', requireCapability('admin:manage'), signInPolicyLimit, asyncHandler(async (req, res) => {
  const patch = signInPolicySchema.parse(req.body);
  // Read and write in one serialised transaction. policyJson is one column
  // holding every organisation setting, so a read-modify-write outside a
  // transaction silently drops whichever of two concurrent saves finishes
  // first — and here one of the two is a security control.
  const { before, wasPolicy, nowPolicy, changed, updated } = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: req.auth!.tenantId }, select: { policyJson: true, listed: true, mfaEpoch: true } });
    // Lenient on read, like the GET beside it: a policyJson that cannot be
    // parsed should not make the page that fixes it impossible to save.
    const current = parseJsonOptional<Record<string, unknown>>(tenant.policyJson, {}, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' });
    const was = mfaPolicyOf(current);
    const next = patch.mfaPolicy ?? was;
    const row = await tx.tenant.update({
      where: { id: req.auth!.tenantId },
      data: {
        policyJson: JSON.stringify({ ...current, mfaPolicy: next }),
        ...(patch.listed === undefined ? {} : { listed: patch.listed }),
        // Only on a real change. Bumping it on every save would sign everyone's
        // remembered devices out whenever an admin opened the page and pressed
        // save without changing anything.
        ...(next !== was ? { mfaEpoch: { increment: 1 } } : {}),
      },
      select: { listed: true, mfaEpoch: true },
    });
    return { before: { mfaPolicy: was, listed: tenant.listed }, wasPolicy: was, nowPolicy: next, changed: next !== was, updated: row };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((err: unknown) => {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      throw new HttpError(409, 'Another change to this organisation happened at the same moment. Try again.');
    }
    throw err;
  });

  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'tenant.signin_policy_updated',
    entityType: 'Tenant', entityId: req.auth!.tenantId, requestId: req.requestId,
    before,
    after: { mfaPolicy: nowPolicy, listed: updated.listed, ip: req.ip ?? 'unknown', trustedDevicesRetired: changed },
  });

  res.json({
    mfaPolicy: nowPolicy, policies: MFA_POLICIES, listed: updated.listed,
    note: changed
      ? 'Saved. Devices people asked to be remembered on will be asked for a code again the next time they sign in.'
      : 'Saved.',
  });
}));

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
// Mailing a reset link is free to ask for and not free to receive: a script
// with one admin session could otherwise fill a colleague's inbox, or wear
// through the per-account hourly ceiling on somebody else's behalf. Keyed on
// the admin rather than the address, so one impatient admin cannot stop every
// other admin in the building from helping anyone. Fails closed for the same
// reason the sign-in limiter does — an outage must not become an open window.
const passwordResetSendLimit = rateLimit({
  name: 'admin-password-reset', windowMs: 60 * 60_000, max: 20, failClosed: true,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

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
  // The one floor, shared with /api/auth/register, /api/signup and the reset
  // page (domain/passwordPolicy.ts). An admin-created account is a real login;
  // letting it be weaker than a self-registered one would make the admin path
  // the soft target, and four separate copies of the rule was four chances for
  // exactly that to happen by accident.
  password: passwordSchema,
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

/**
 * Send a colleague a link to set a new password.
 *
 * An admin never sets, sees or chooses another person's password — they can
 * only cause a link to be mailed to the address already on the account. That is
 * the whole difference between helping a colleague back in and being able to
 * walk into their account: the link goes to their mailbox, not to the admin's
 * screen, and the audit trail records who caused it.
 *
 * Tenant-scoped through `tenantUser`, so an admin cannot aim this at somebody
 * else's organisation. The platform operator is the one exception, below.
 */
adminRouter.post('/users/:id/password-reset', requireCapability('admin:manage'), passwordResetSendLimit, asyncHandler(async (req, res) => {
  const target = await tenantUser(req.auth!.tenantId, req.params.id);
  // Awaited, unlike the public route. The reason that one answers before doing
  // the work is enumeration — it must not say whether the address has an
  // account — and there is no such question here: the admin is looking at the
  // row. So they are told what actually happened, which matters, because the
  // cooldown and the hourly ceiling are shared with the colleague's own
  // "Forgot password" and "nothing was sent" is a thing an admin needs to know.
  const outcome = await requestPasswordReset(target.email, {
    ip: req.ip ?? 'unknown', requestId: req.requestId, requestedBy: 'admin', requestedById: req.auth!.userId,
  });
  res.status(outcome.kind === 'sent' ? 202 : 200).json({
    ok: outcome.kind === 'sent',
    outcome: outcome.kind,
    message: messageForAdmin(outcome, target.email),
  });
}));

function messageForAdmin(outcome: ResetRequestOutcome, email: string): string {
  switch (outcome.kind) {
    case 'sent':
      return `A link to set a new password is on its way to ${email}. It works once and expires in an hour.`;
    case 'wait':
      return outcome.reason === 'cooldown'
        ? `A link was sent to ${email} in the last minute — they should have it. Wait a moment before sending another.`
        : `${email} has been sent several links in the last hour. Ask them to check their spam folder before sending more.`;
    case 'not_delivered':
      return `We could not email ${email}. Nothing was sent; try again shortly.`;
    default:
      // 'no_account': the row exists in this tenant, so this is a demo visitor
      // or an account that cannot hold a password of its own.
      return `${email} does not sign in with a password, so there is nothing to reset.`;
  }
}

/**
 * Forget every device a colleague asked to be remembered on.
 *
 * What an admin reaches for when someone says their laptop is gone. It does not
 * touch the password or the session — those have their own answers — it removes
 * the standing permission to skip the code step, which is the thing a lost
 * laptop carries and a lost password does not.
 */
adminRouter.post('/users/:id/revoke-devices', requireCapability('admin:manage'), revokeDevicesLimit, asyncHandler(async (req, res) => {
  const target = await tenantUser(req.auth!.tenantId, req.params.id);
  const count = await revokeAllTrustedDevices(target.id, req.auth!.tenantId, {
    ip: req.ip ?? 'unknown', requestId: req.requestId, actorId: req.auth!.userId, reason: 'admin_revoked',
  });
  res.json({
    ok: true, revoked: count,
    message: count === 0
      ? `${target.name} has no remembered devices.`
      : `${target.name} will be asked for a sign-in code on ${count === 1 ? 'that device' : 'all their devices'} again.`,
  });
}));

/**
 * The same, for an organisation that has nobody left who can do it.
 *
 * An admin locked out of an organisation with other admins is helped by one of
 * them. An organisation whose ONLY admin is locked out has nobody: the route
 * above needs `admin:manage` inside that tenant, and there is no one holding
 * it. Self-service covers the ordinary case — the locked-out admin asks for a
 * link themselves, since that path needs no admin at all — so this exists for
 * the case where self-service cannot work either: the address on the account is
 * a mailbox they have lost, or the person left and the organisation needs its
 * own admin back.
 *
 * Restricted to the platform operator, who is the only party outside a tenant
 * with any standing at all, and who still cannot choose the password — the link
 * goes to the address on the account, not to them. Anything beyond that (the
 * mailbox itself is gone) is a support conversation with identity checks, not
 * an endpoint, because no automated proof of "this really is the company" fits
 * in an HTTP request.
 */
/**
 * Break-glass: let one named person sign in without a code, once, for half an
 * hour.
 *
 * The second factor here is email, and email breaks. Without a way out, a mail
 * outage or a mailbox that has stopped accepting our messages locks an
 * organisation's admins out of their own product — and the remedy would then be
 * invented during the incident by whoever has database access. This is that
 * remedy, decided in daylight: bounded, single use, granted only by the
 * platform operator, and written into the organisation's own audit trail both
 * when it is granted and when it is spent.
 *
 * It skips the CODE, never the PASSWORD. A grant handed to the wrong person is
 * not on its own a way into anything.
 */
const bypassSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();

adminRouter.post('/tenants/:tenantId/users/:id/mfa-bypass', requirePlatformOperator, passwordResetSendLimit, asyncHandler(async (req, res) => {
  // A reason is required, and it is required to be a sentence. This is the one
  // route in the app that weakens someone's sign-in, and "why" is the whole
  // record of whether it should have been used.
  const { reason } = bypassSchema.parse(req.body);
  const target = await prisma.user.findFirst({
    where: { id: req.params.id, tenantId: req.params.tenantId }, select: { id: true, tenantId: true, email: true },
  });
  if (!target) throw new HttpError(404, 'User not found');
  // Never to yourself.
  //
  // domain/mfaPolicy.ts says the platform owner is asked for a code whatever
  // an organisation has chosen, and deviceMayStandIn is careful to refuse a
  // trusted device for exactly that account. A self-grant walks around both:
  // grant, spend, grant again, and the strongest account on the platform is
  // password-only for as long as its holder likes — with the record of it
  // written by the person being watched.
  //
  // Another operator can still grant it, which is the shape this should have:
  // a second pair of hands. A deployment with one operator recovers a mail
  // outage by fixing mail or by naming a second operator, both of which are
  // decisions at the right level rather than a button.
  if (target.id === req.auth!.userId) {
    throw new HttpError(403, 'A platform owner cannot grant themselves a sign-in bypass. Ask another platform owner.');
  }
  const until = await grantMfaBypass(target, { id: req.auth!.userId }, { ip: req.ip ?? 'unknown', requestId: req.requestId, reason });
  res.status(202).json({
    ok: true, until: until.toISOString(), minutes: BYPASS_WINDOW_MS / 60_000,
    message: `${target.email} can sign in with their password alone, once, until ${until.toISOString()}. They still need the password.`,
  });
}));

adminRouter.post('/tenants/:tenantId/users/:id/password-reset', requirePlatformOperator, passwordResetSendLimit, asyncHandler(async (req, res) => {
  const target = await prisma.user.findFirst({
    where: { id: req.params.id, tenantId: req.params.tenantId }, select: { id: true, email: true, role: true },
  });
  if (!target) throw new HttpError(404, 'User not found');
  startPasswordResetRequest(target.email, {
    ip: req.ip ?? 'unknown', requestId: req.requestId, requestedBy: 'operator', requestedById: req.auth!.userId,
  });
  res.status(202).json({ ok: true, message: `A link to set a new password is on its way to ${target.email}.` });
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
