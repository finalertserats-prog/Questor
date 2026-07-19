import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { config } from '../config.js';
import { hashPassword } from '../services/auth.js';
import { isRoleName, ROLES } from '../domain/capabilities.js';
import { assignRole, assignCandidate } from '../services/access.js';
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
//
// Was readable by any authenticated user in the tenant. The audit trail names
// who acted on which entity id and when — a recruiter could enumerate every
// candidate id in the tenant from it without ever being assigned one, which is
// precisely the disclosure object scoping exists to close.
adminRouter.get('/audit', requireCapability('audit:read'), asyncHandler(async (req, res) => {
  const events = await prisma.auditEvent.findMany({ where: { tenantId: req.auth!.tenantId }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ events: events.map((e) => ({ id: e.id, actorId: e.actorId, actorType: e.actorType, action: e.action, entityType: e.entityType, entityId: e.entityId, createdAt: e.createdAt })) });
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

// Webhook endpoints CRUD (FR-039)
//
// The read was ungated while the write was admin-only, which is backwards as a
// pair: a webhook row is a delivery URL, and those routinely embed a shared
// secret in the path or query. Any tenant user could read them and then receive
// (or replay to) the tenant's outbound event stream.
adminRouter.get('/webhooks', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const hooks = await prisma.webhookEndpoint.findMany({ where: { tenantId: req.auth!.tenantId } });
  res.json({ webhooks: hooks });
}));
adminRouter.post('/webhooks', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
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
  res.json({ policy: parseJson(tenant?.policyJson ?? '{}', {}) });
}));
adminRouter.put('/policy', requireCapability('admin:manage'), asyncHandler(async (req, res) => {
  const policy = req.body?.policy ?? {};
  await prisma.tenant.update({ where: { id: req.auth!.tenantId }, data: { policyJson: JSON.stringify(policy) } });
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
  email: z.string().email(),
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
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw new HttpError(409, 'Email already registered');

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
  if (target.role === 'admin' && role !== 'admin') {
    const admins = await prisma.user.count({ where: { tenantId: req.auth!.tenantId, role: 'admin' } });
    if (admins <= 1) throw new HttpError(409, 'Cannot remove the last admin; promote another user first');
  }

  const updated = await prisma.user.update({ where: { id: target.id }, data: { role }, select: USER_FIELDS });

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'user.role_changed', entityType: 'User', entityId: target.id,
    before: { role: target.role }, after: { role: updated.role },
  });

  // Role lives in the JWT claims, so an already-issued token keeps the old role
  // until it expires. A demotion is therefore not immediate — surfaced in the
  // response rather than left for an admin to discover during an incident.
  res.json({ user: updated, note: 'Existing sessions keep their previous role until their token expires.' });
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
