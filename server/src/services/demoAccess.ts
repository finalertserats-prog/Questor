import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DemoGrant, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import { consume } from '../middleware/rateLimit.js';
import { hashPassword, issueSession, type AuthClaims } from './auth.js';
import { logAudit } from './audit.js';
import { getEmail } from '../providers/email/index.js';
import { invitationSecretColumns, mintInvitationToken } from './invitations.js';
import { extractRoleHeuristic } from '../engines/roleIntelligence.js';
import { normalizeProfile } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import { DEMO_JD, DEMO_RESUME } from '../seed/demoData.js';
import { renderDemoAccessEmail, renderDemoOperatorEmail, renderDemoDecisionEmail, renderDemoDeclinedEmail } from '../providers/email/demoEmail.js';

const DAY_MS = 86_400_000;
const LINK_TTL_MS = 72 * 60 * 60_000;
const TENANT_TTL_MS = 7 * DAY_MS;
const SESSION_TTL_SECONDS = 45 * 60;

export { demoRecipientBlocked, isHeuristicOnlySession } from './demoPolicy.js';
const DECISION_TTL_MS = 14 * DAY_MS;
/** How long an operator's decline stands before the visitor may ask again. */
const DECLINE_COOLDOWN_MS = 30 * DAY_MS;
/** How long a creation slot is held: longer than any one create request takes. */
const CAP_SLOT_HOLD_MS = 2 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;

type Decision = 'approve' | 'decline';

export function mintDemoToken(): string { return randomBytes(32).toString('base64url'); }
export function hashDemoToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function hashRequestIp(ip: string): string { return createHash('sha256').update(`demo-request:${ip}`).digest('hex'); }

function matchHash(a: string | null, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
function webUrl(path: string): string { return `${config.webOrigin.replace(/\/+$/, '')}${path}`; }
function slugify(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'demo'; }
async function uniqueTenantSlug(tx: PrismaClient, name: string): Promise<string> {
  const base = slugify(`${name}-demo`);
  for (let i = 0; i < 20; i += 1) {
    const slug = i === 0 ? base : `${base}-${i + 1}`.slice(0, 40);
    if (!(await tx.tenant.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base.slice(0, 27)}-${randomBytes(4).toString('hex')}`;
}
/** The catalog's Data Engineer role, so the demo shows a role linked the way new roles are. */
async function demoCatalogRole(tx: PrismaClient): Promise<string | null> {
  const role = await tx.catalogRole.findFirst({ where: { normalizedTitle: 'data engineer', status: 'active' }, select: { id: true } });
  return role?.id ?? null;
}

export interface ProvisionedDemoTenant { tenantId: string; userId: string; invitationToken: string; sessionId: string }

export async function provisionDemoTenant(input: { name: string; email: string; company: string; now?: Date }): Promise<ProvisionedDemoTenant> {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    // Default policy and persona: the demo shows the product as a customer gets it.
    const tenant = await tx.tenant.create({ data: { name: `${input.company} (demo)`, slug: await uniqueTenantSlug(tx as PrismaClient, input.company), isDemo: true, demoExpiresAt: new Date(now.getTime() + TENANT_TTL_MS) } });
    const user = await tx.user.create({ data: { tenantId: tenant.id, email: input.email, name: input.name, passwordHash: hashPassword(randomBytes(32).toString('base64url')), role: 'manager', tourCompletedAt: null } });
    const extraction = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer');
    const role = await tx.role.create({ data: { tenantId: tenant.id, catalogRoleId: await demoCatalogRole(tx as PrismaClient), title: extraction.title, level: extraction.level, location: extraction.location, employmentType: extraction.employmentType, sourceType: 'paste', sourceText: DEMO_JD, status: 'approved', createdById: user.id } });
    const scorecard = await tx.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(extraction.profile), approvedById: user.id, approvedAt: now } });
    const resume = DEMO_RESUME.replace('priya.sharma@example.com', input.email);
    const candidate = await tx.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName: input.name, email: input.email, phone: '' } });
    const profile = normalizeProfile(resume);
    const { fit } = computeFitScore(profile, resume, extraction.profile);
    await tx.candidateProfileVersion.create({ data: { candidateId: candidate.id, version: 1, rawText: resume, profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit) } });
    const plan = buildInterviewPlan({ role: extraction.profile, fit, durationMinutes: 45, language: 'en', modules: [] });
    // INVITED with no consent recorded: the visitor meets the consent step exactly
    // as a candidate would, which is part of what the demo is showing.
    const session = await tx.interviewSession.create({ data: { tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id, state: 'INVITED', provider: 'hosted', language: 'en', durationMinutes: 45 } });
    await tx.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
    const invitationToken = mintInvitationToken();
    await tx.invitation.create({ data: { sessionId: session.id, ...invitationSecretColumns(invitationToken), status: 'sent', sentAt: now, expiresAt: new Date(now.getTime() + TENANT_TTL_MS) } });
    await tx.roleAssignment.create({ data: { roleId: role.id, userId: user.id, relation: 'owner' } });
    await tx.candidateAssignment.create({ data: { candidateId: candidate.id, userId: user.id, relation: 'owner' } });
    return { tenantId: tenant.id, userId: user.id, invitationToken, sessionId: session.id };
  });
}

/**
 * True when a real (non-demo) account already holds this address. User.email is
 * unique across the whole deployment, so a sandbox user for it cannot exist;
 * trying anyway used to throw inside provisioning and be swallowed.
 */
async function realAccountHolds(email: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { email }, select: { tenant: { select: { isDemo: true } } } });
  return !!user && !user.tenant.isDemo;
}

type SandboxOwner = Pick<DemoGrant, 'tenantId' | 'userId' | 'name' | 'email' | 'company'>;

/**
 * A sandbox that will outlive the link about to be issued: the grant's own,
 * kept alive for another full term, or a new one when the purge removed it.
 * Extending on every (re)issue is what keeps a fresh 72-hour link from pointing
 * at a sandbox the purge deletes the next day.
 */
async function ensureSandbox(owner: SandboxOwner, now: Date): Promise<{ tenantId: string; userId: string; provisioned: boolean }> {
  if (owner.tenantId && owner.userId) {
    const kept = await prisma.tenant.updateMany({ where: { id: owner.tenantId, isDemo: true }, data: { demoExpiresAt: new Date(now.getTime() + TENANT_TTL_MS) } });
    if (kept.count === 1) return { tenantId: owner.tenantId, userId: owner.userId, provisioned: false };
  }
  if (await realAccountHolds(owner.email)) throw new HttpError(409, 'This address now has a Questor account, so a demo cannot be set up for it.');
  const provisioned = await provisionDemoTenant({ name: owner.name, email: owner.email, company: owner.company, now });
  return { tenantId: provisioned.tenantId, userId: provisioned.userId, provisioned: true };
}

/** A sandbox made for a grant that lost a race is surplus: hand it to the purge job. */
async function retireSurplusSandbox(tenantId: string, now: Date): Promise<void> {
  await prisma.tenant.updateMany({ where: { id: tenantId, isDemo: true }, data: { demoExpiresAt: now } });
}

function sandboxAlive(tenant: { demoExpiresAt: Date | null } | null, now: Date): boolean {
  return !!tenant && (!tenant.demoExpiresAt || tenant.demoExpiresAt > now);
}

/**
 * A new link on an unused grant. The link is stored hashed, so a lost one
 * cannot be re-sent: a new one is minted and the old one stops working. The
 * grant row is always reused — DemoGrant.email is unique, and creating a second
 * row for the address is what used to lock a returning visitor out for good.
 */
async function reissueLink(grant: DemoGrant, now: Date): Promise<void> {
  const sandbox = await ensureSandbox(grant, now);
  const token = mintDemoToken();
  const changed = await prisma.demoGrant.updateMany({
    // Guarded on the current link, so of two concurrent re-issues one wins.
    where: { id: grant.id, status: 'sent', linkTokenHash: grant.linkTokenHash },
    data: { linkTokenHash: hashDemoToken(token), linkExpiresAt: new Date(now.getTime() + LINK_TTL_MS), tenantId: sandbox.tenantId, userId: sandbox.userId, consumedAt: null, sessionEndsAt: null },
  });
  if (changed.count !== 1) {
    if (sandbox.provisioned) await retireSurplusSandbox(sandbox.tenantId, now);
    return;
  }
  await logAudit({ tenantId: sandbox.tenantId, actorType: 'system', actorId: 'demo-request', action: 'demo.link_reissued', entityType: 'DemoGrant', entityId: grant.id });
  await getEmail().send(renderDemoAccessEmail({ to: grant.email, name: grant.name, linkUrl: webUrl(`/demo/${token}`) }));
}

/**
 * One grant per address. An unused grant gets a fresh link (and a sandbox, if
 * the old one was purged); a demo already used goes to the operator for
 * approval, exactly like "request access again" — a second demo is the owner's
 * call, not the visitor's.
 */
export async function requestDemoAccess(input: { name: string; email: string; company: string; ip: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  if (await realAccountHolds(email)) {
    // The route answers 202 either way; the address is not echoed into logs.
    logger.info('Demo requested for an address that already has an account; no sandbox built');
    return;
  }
  const existing = await prisma.demoGrant.findUnique({ where: { email } });
  if (existing?.status === 'sent') {
    await reissueLink(existing, now);
    return;
  }
  if (existing) {
    await requestReaccessForGrant(existing, now);
    return;
  }
  const token = mintDemoToken();
  const provisioned = await provisionDemoTenant({ name: input.name, email, company: input.company, now });
  let grant;
  try {
    grant = await prisma.demoGrant.create({ data: { name: input.name, email, company: input.company, status: 'sent', linkTokenHash: hashDemoToken(token), linkExpiresAt: new Date(now.getTime() + LINK_TTL_MS), tenantId: provisioned.tenantId, userId: provisioned.userId, requestIpHash: hashRequestIp(input.ip) } });
  } catch (err) {
    // Two requests for one address raced and the other won: this sandbox is
    // surplus, so hand it to the purge job and send nothing.
    if ((err as { code?: string } | null)?.code !== 'P2002') throw err;
    await retireSurplusSandbox(provisioned.tenantId, now);
    return;
  }
  if (config.signupApproverEmail.trim()) {
    await getEmail().send(renderDemoOperatorEmail({ to: config.signupApproverEmail, name: input.name, email, company: input.company }));
  } else {
    logger.warn('SIGNUP_APPROVER_EMAIL is not set; demo request operator notice was not sent');
  }
  await logAudit({ tenantId: provisioned.tenantId, actorType: 'system', actorId: 'demo-request', action: 'demo.requested', entityType: 'DemoGrant', entityId: grant.id, after: { email, company: input.company } });
  await getEmail().send(renderDemoAccessEmail({ to: email, name: input.name, linkUrl: webUrl(`/demo/${token}`) }));
}

export async function redeemDemoAccess(token: string, res: import('express').Response, now = new Date()) {
  if (!TOKEN_SHAPE.test(token)) throw new HttpError(410, 'This demo link cannot be used.', 'unknown');
  const tokenHash = hashDemoToken(token);
  // The sandbox is checked BEFORE the grant is consumed: consuming first turned
  // a purged sandbox into a used link, and a used link needs the operator.
  const pending = await prisma.demoGrant.findUnique({ where: { linkTokenHash: tokenHash }, select: { status: true, linkExpiresAt: true, tenant: { select: { demoExpiresAt: true } } } });
  if (pending?.status === 'sent' && pending.linkExpiresAt && pending.linkExpiresAt > now && !sandboxAlive(pending.tenant, now)) {
    throw new HttpError(410, 'This demo link cannot be used.', 'expired');
  }
  // tenantId is re-checked in the claim itself: the purge clears it.
  const consumed = await prisma.demoGrant.updateMany({ where: { linkTokenHash: tokenHash, status: 'sent', linkExpiresAt: { gt: now }, tenantId: { not: null } }, data: { status: 'consumed', consumedAt: now, sessionEndsAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000) } });
  if (consumed.count === 0) throw await redeemGone(tokenHash, now);
  const grant = await prisma.demoGrant.findUnique({ where: { linkTokenHash: tokenHash }, include: { tenant: true, user: true } });
  if (!grant?.tenant || !grant.user || !grant.sessionEndsAt || !matchHash(grant.linkTokenHash, tokenHash)) throw new HttpError(410, 'This demo link cannot be used.', 'unknown');
  await prisma.user.update({ where: { id: grant.user.id }, data: { tourCompletedAt: null } });
  // The sample interview's candidate link lives exactly as long as the demo:
  // a copied link must not keep a sandbox interview (and its speech) running.
  await expireDemoInterviewLinks(grant.tenant.id, grant.sessionEndsAt);
  const claims: AuthClaims = { userId: grant.user.id, tenantId: grant.tenant.id, role: grant.user.role, email: grant.user.email, demo: true, demoGrantId: grant.id };
  const sessionToken = issueSession(res, claims, { ttlSeconds: SESSION_TTL_SECONDS });
  await logAudit({ tenantId: grant.tenant.id, actorType: 'system', actorId: grant.user.id, action: 'demo.redeemed', entityType: 'DemoGrant', entityId: grant.id });
  return { token: sessionToken, user: { id: grant.user.id, name: grant.user.name, email: grant.user.email, role: grant.user.role, tourCompletedAt: null }, tenant: { id: grant.tenant.id, name: grant.tenant.name, region: grant.tenant.region, slug: grant.tenant.slug, isDemo: true }, sessionEndsAt: grant.sessionEndsAt.toISOString() };
}

async function redeemGone(tokenHash: string, now: Date): Promise<HttpError> {
  const row = await prisma.demoGrant.findUnique({ where: { linkTokenHash: tokenHash }, select: { status: true, linkExpiresAt: true, tenantId: true } });
  const sandboxGone = row?.status === 'sent' && !row.tenantId;
  const reason = row?.status === 'consumed' || row?.status === 'reaccess_requested' ? 'used' : sandboxGone || (row?.linkExpiresAt && row.linkExpiresAt <= now) ? 'expired' : 'unknown';
  return new HttpError(410, 'This demo link cannot be used.', reason);
}

export async function requestDemoReaccess(input: { token: string; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  if (!TOKEN_SHAPE.test(input.token)) return;
  const tokenHash = hashDemoToken(input.token);
  const grant = await prisma.demoGrant.findUnique({ where: { linkTokenHash: tokenHash }, include: { tenant: { select: { demoExpiresAt: true } } } });
  if (!grant || !matchHash(grant.linkTokenHash, tokenHash)) return;
  if (grant.status === 'sent') {
    // Never used: a fresh link is the visitor's to have, not the operator's to
    // grant. Nothing to do while the link they hold still works.
    if (grant.linkExpiresAt && grant.linkExpiresAt > now && sandboxAlive(grant.tenant, now)) return;
    if (await realAccountHolds(grant.email)) return;
    const { tenant: _tenant, ...row } = grant;
    await reissueLink(row, now);
    return;
  }
  await requestReaccessForGrant(grant, now);
}

/**
 * Ask the operator to approve another demo for this grant; idempotent while a
 * decision is pending, and silent while a decline stands (L10): a declined
 * visitor pressing "ask again" must not mail the operator every time.
 */
async function requestReaccessForGrant(grant: DemoGrant, now: Date): Promise<void> {
  const pending = grant.status === 'reaccess_requested' && grant.decisionTokenHash && grant.decisionExpiresAt && grant.decisionExpiresAt > now;
  if (pending) return;
  if (grant.status === 'declined' && grant.decisionExpiresAt && grant.decisionExpiresAt > now) return;
  const decisionToken = mintDemoToken();
  const updated = await prisma.demoGrant.update({ where: { id: grant.id }, data: { status: 'reaccess_requested', decisionTokenHash: hashDemoToken(decisionToken), decisionExpiresAt: new Date(now.getTime() + DECISION_TTL_MS) } });
  if (updated.tenantId) await logAudit({ tenantId: updated.tenantId, actorType: 'system', actorId: 'demo-reaccess', action: 'demo.reaccess_requested', entityType: 'DemoGrant', entityId: updated.id });
  if (!config.signupApproverEmail.trim()) {
    logger.warn({ grantId: grant.id }, 'SIGNUP_APPROVER_EMAIL is not set; a demo re-access request cannot reach the operator');
    return;
  }
  const decisionUrl = webUrl(`/demo/decision/${decisionToken}`);
  await getEmail().send(renderDemoDecisionEmail({ to: config.signupApproverEmail, name: grant.name, email: grant.email, company: grant.company, approveUrl: decisionUrl, declineUrl: decisionUrl }));
}

export async function resolveDemoDecision(token: string, now = new Date()) {
  if (!TOKEN_SHAPE.test(token)) throw new HttpError(404, 'This demo decision link is not valid.');
  const tokenHash = hashDemoToken(token);
  const row = await prisma.demoGrant.findUnique({ where: { decisionTokenHash: tokenHash } });
  if (!row || !matchHash(row.decisionTokenHash, tokenHash)) throw new HttpError(404, 'This demo decision link is not valid.');
  if (!row.decisionExpiresAt || row.decisionExpiresAt <= now) throw new HttpError(410, 'This demo request has expired.');
  return row;
}

export async function decideDemoAccess(opts: { token: string; decision: Decision; now?: Date }): Promise<boolean> {
  const now = opts.now ?? new Date();
  const row = await resolveDemoDecision(opts.token, now);
  if (row.status !== 'reaccess_requested') return false;
  if (opts.decision === 'decline') {
    // With no decision token, decisionExpiresAt marks when the decline lapses
    // and the visitor may ask the operator again.
    const changed = await prisma.demoGrant.updateMany({ where: { id: row.id, status: 'reaccess_requested' }, data: { status: 'declined', decisionTokenHash: null, decisionExpiresAt: new Date(now.getTime() + DECLINE_COOLDOWN_MS) } });
    if (changed.count !== 1) return false;
    await getEmail().send(renderDemoDeclinedEmail({ to: row.email, name: row.name }));
    if (row.tenantId) await logAudit({ tenantId: row.tenantId, actorType: 'system', actorId: 'demo-decision', action: 'demo.declined', entityType: 'DemoGrant', entityId: row.id });
    return true;
  }
  const linkToken = mintDemoToken();
  const sandbox = await ensureSandbox(row, now);
  const changed = await prisma.demoGrant.updateMany({ where: { id: row.id, status: 'reaccess_requested' }, data: { status: 'sent', linkTokenHash: hashDemoToken(linkToken), linkExpiresAt: new Date(now.getTime() + LINK_TTL_MS), consumedAt: null, sessionEndsAt: null, decisionTokenHash: null, decisionExpiresAt: null, tenantId: sandbox.tenantId, userId: sandbox.userId } });
  if (changed.count !== 1) {
    if (sandbox.provisioned) await retireSurplusSandbox(sandbox.tenantId, now);
    return false;
  }
  await getEmail().send(renderDemoAccessEmail({ to: row.email, name: row.name, linkUrl: webUrl(`/demo/${linkToken}`) }));
  await logAudit({ tenantId: sandbox.tenantId, actorType: 'system', actorId: 'demo-decision', action: 'demo.approved', entityType: 'DemoGrant', entityId: row.id });
  return true;
}

/**
 * Free an address a demo user holds, so a real account can be created for it.
 * User.email is unique across the deployment; without this, approving a real
 * signup for someone who once tried the demo fails. The demo user is renamed
 * (not deleted — the sandbox's records still point at it), its session ends,
 * its link stops working, and its sandbox is handed to the purge job. Returns
 * false, touching nothing, when the address is free or held by a real account.
 *
 * Signup approval must call this before it creates the user.
 */
export async function releaseDemoEmail(email: string, now = new Date()): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalized }, select: { id: true, tenantId: true, tenant: { select: { isDemo: true } } } });
  if (!user?.tenant.isDemo) return false;
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { email: `released-${user.id}@demo.invalid` } }),
    prisma.demoGrant.updateMany({ where: { userId: user.id }, data: { sessionEndsAt: now, linkExpiresAt: now } }),
    prisma.tenant.update({ where: { id: user.tenantId }, data: { demoExpiresAt: now } }),
  ]);
  await logAudit({ tenantId: user.tenantId, actorType: 'system', actorId: 'demo-release', action: 'demo.email_released', entityType: 'User', entityId: user.id });
  return true;
}

/** Candidate links in a sandbox stop working at `at`. */
export async function expireDemoInterviewLinks(tenantId: string, at: Date): Promise<void> {
  await prisma.invitation.updateMany({ where: { session: { tenantId, tenant: { isDemo: true } } }, data: { expiresAt: at } });
}

export async function assertNotDemoTenant(tenantId: string, message = 'Not available in the demo'): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isDemo: true } });
  if (tenant?.isDemo) throw new HttpError(403, message);
}

/**
 * Refuse a creation that would take a sandbox past its cap. The count alone
 * raced: concurrent requests all read the same count and all created. Each
 * creation therefore also claims a numbered slot (count, count + 1, ... up to
 * the cap) in the shared atomic counter store, and a slot is held long enough
 * for its create to land, so no more creations pass than the cap leaves room for.
 */
export async function assertDemoCreationCap(tenantId: string, kind: 'roles' | 'candidates' | 'interviews'): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isDemo: true } });
  if (!tenant?.isDemo) return;
  const caps = { roles: 3, candidates: 5, interviews: 5 };
  const count = kind === 'roles' ? await prisma.role.count({ where: { tenantId } }) : kind === 'candidates' ? await prisma.candidate.count({ where: { tenantId } }) : await prisma.interviewSession.count({ where: { tenantId } });
  if (count >= caps[kind]) throw new HttpError(409, `Demo limit reached: at most ${caps[kind]} ${kind} are available in the demo.`);
  for (let slot = count; slot < caps[kind]; slot += 1) {
    const verdict = await consume('demo-cap', `${tenantId}:${kind}:${slot}`, CAP_SLOT_HOLD_MS, 1, { failClosed: true });
    if (verdict.allowed) return;
    if (verdict.reason === 'unavailable') throw new HttpError(503, 'The demo is briefly unavailable. Please try again shortly.');
  }
  throw new HttpError(409, `Demo limit reached: at most ${caps[kind]} ${kind} are available in the demo. If one is still being created, try again in a moment.`);
}

export async function purgeExpiredDemoTenants(now = new Date()): Promise<number> {
  const tenants = await prisma.tenant.findMany({ where: { isDemo: true, demoExpiresAt: { lte: now } }, select: { id: true } });
  const tenantIds = tenants.map((t) => t.id);
  if (tenantIds.length === 0) return 0;
  await prisma.$transaction(async (tx) => {
    await tx.demoGrant.updateMany({ where: { tenantId: { in: tenantIds } }, data: { tenantId: null, userId: null } });
    const sessions = await tx.interviewSession.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
    const sessionIds = sessions.map((s) => s.id);
    const candidates = await tx.candidate.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } });
    const candidateIds = candidates.map((c) => c.id);
    const profiles = await tx.candidateProfileVersion.findMany({ where: { candidateId: { in: candidateIds } }, select: { id: true } });
    const profileIds = profiles.map((p) => p.id);
    const nodes = await tx.evidenceNode.findMany({ where: { profileId: { in: profileIds } }, select: { id: true } });
    const nodeIds = nodes.map((n) => n.id);
    if (nodeIds.length) await tx.evidenceEdge.deleteMany({ where: { OR: [{ fromId: { in: nodeIds } }, { toId: { in: nodeIds } }] } });
    await tx.evidenceNode.deleteMany({ where: { profileId: { in: profileIds } } });
    await tx.candidateProfileVersion.deleteMany({ where: { candidateId: { in: candidateIds } } });
    await tx.candidateFeedbackDelivery.deleteMany({ where: { assessment: { sessionId: { in: sessionIds } } } });
    await tx.humanReview.deleteMany({ where: { assessment: { sessionId: { in: sessionIds } } } });
    await tx.assessmentVersion.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.candidateFeedbackOptIn.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidateHumanRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidateFeedbackOptInRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.turn.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.invitation.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.interviewPlanVersion.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.integrityEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.artifact.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.modelExecution.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.observationSegment.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.roundObservation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.interviewRound.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidatePipeline.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.roleAssignment.deleteMany({ where: { role: { tenantId: { in: tenantIds } } } });
    await tx.candidateAssignment.deleteMany({ where: { candidate: { tenantId: { in: tenantIds } } } });
    await tx.candidateAtsLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.atsRequisitionImport.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.atsConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.interviewSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidate.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.roleScorecardVersion.deleteMany({ where: { role: { tenantId: { in: tenantIds } } } });
    await tx.role.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.auditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.tenant.deleteMany({ where: { id: { in: tenantIds }, isDemo: true } });
  });
  for (const tenantId of tenantIds) logger.info({ tenantId }, 'Purged expired demo tenant');
  return tenantIds.length;
}
