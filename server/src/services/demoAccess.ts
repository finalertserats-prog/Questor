import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DemoGrant, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';
import { normalizeEmail } from './userEmail.js';
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
import { DEMO_JD, visitorResume } from '../seed/demoData.js';
import { DEMO_STORY_INTERVIEWER, curateDemoScorecard, seedDemoStory } from '../seed/demoStory.js';
import { slugifyCatalogName } from '../domain/catalogText.js';
import { DEMO_ROLE } from '../domain/capabilities.js';
import { nextStageKey, parseStages } from '../domain/pipelineStages.js';
import { assignInterviewer } from './interviewers.js';
import { DEFAULT_DISCLOSURE_BODY, composeDisclosure } from '../domain/interviewerModel.js';
import { DEMO_READ_ONLY_MESSAGE } from './demoPolicy.js';
import { advancePipeline, applyPipelineEvent } from './pipelineAutonomy.js';
import type { PipelineEvent } from '../domain/pipelineAutonomy.js';
import { renderDemoAccessEmail, renderDemoOperatorEmail, renderDemoDecisionEmail, renderDemoDeclinedEmail } from '../providers/email/demoEmail.js';

const DAY_MS = 86_400_000;
const LINK_TTL_MS = 72 * 60 * 60_000;
const TENANT_TTL_MS = 7 * DAY_MS;
const SESSION_TTL_SECONDS = 45 * 60;

export { demoRecipientBlocked, isHeuristicOnlySession } from './demoPolicy.js';
const DECISION_TTL_MS = 14 * DAY_MS;
/** How long an operator's decline stands before the visitor may ask again. */
const DECLINE_COOLDOWN_MS = 7 * DAY_MS;
/** A lost link is re-sent at most this often. */
const RESEND_EVERY_MS = 10 * 60_000;
/** How long a creation slot is held: longer than any one create request takes. */
const CAP_SLOT_HOLD_MS = 2 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;
/** How long provisioning a sandbox, story and all, may take before it is given up. */
const PROVISION_TIMEOUT_MS = 30_000;

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
  // The seeded entry in the data domain, never an org-added namesake elsewhere.
  const role = await tx.catalogRole.findFirst({
    where: { normalizedTitle: 'data engineer', status: 'active', source: 'seed', domain: { slug: slugifyCatalogName('Data, Analytics & Decision Science') } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return role?.id ?? null;
}

export interface ProvisionedDemoTenant {
  tenantId: string; userId: string; invitationToken: string; sessionId: string;
  roleId: string; scorecardId: string; candidateId: string;
  /** Priya Sharma's completed, unreviewed interview — the story the guided demo tells. */
  story: { candidateId: string; sessionId: string; assessmentId: string };
}

/** Maya runs the story's interview, so the recorded narration can say her name; the visitor's own keeps the random pick. */
async function demoStoryInterviewer(fallback: { interviewerId: string; name: string }): Promise<{ interviewerId: string; name: string }> {
  const maya = await prisma.aIInterviewer.findFirst({ where: { name: DEMO_STORY_INTERVIEWER, active: true }, select: { id: true, name: true } });
  return maya ? { interviewerId: maya.id, name: maya.name } : fallback;
}

/** The two moves that still happen on their own: the candidate exists, their CV has been read. */
const SELF_MOVING: readonly PipelineEvent[] = ['candidate.onboarded', 'candidate.profiled'];

/**
 * A sandbox candidate walked to the round the AI conducts, the way the product
 * walks anybody there.
 *
 * Onboarding and the CV reading are raised as events, because those two moves
 * are still the product's own. Everything after Bronze is a decision a person
 * records, so this records it — through `advancePipeline`, the same function
 * behind the Advance button on the candidate's page.
 *
 * It used to replay `interview.scheduled` and `interview.assessed` instead.
 * Those events no longer carry a transition (domain/pipelineAutonomy.ts), so
 * replaying them would leave both sandbox candidates at Bronze while the code
 * above claimed otherwise. Going through the real move also means this breaks
 * loudly — in tests/demoStory.test.ts — the next time that path changes, rather
 * than quietly staging a prospect's demo at a tier nobody awarded.
 *
 * Nothing here is allowed to escape. Both a refusal and a throw leave the
 * visitor with a sandbox that is one stage short, which is a poorer demo; what
 * neither may do is fail the request, because by this point their tenant, their
 * story and their invitation have all committed and there is no way to hand
 * them back. `parseStagesStrict` and the award engine inside `advancePipeline`
 * can both throw, so the whole walk is caught — loudly, never silently.
 */
async function walkToAiRound(o: { tenantId: string; userId: string; candidateId: string; roleId: string }): Promise<void> {
  try {
    for (const event of SELF_MOVING) {
      await applyPipelineEvent({ ...o, event, trigger: 'demo.provisioned' });
    }
    const pipeline = await prisma.candidatePipeline.findFirst({
      where: { tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId },
    });
    if (!pipeline) return;
    const stages = parseStages(pipeline.stagesJson);
    // The round the AI conducts, which is where this walk ends. A plan with no
    // such stage has nowhere to walk to, and walking to the end of it instead
    // would put a demo candidate at the final stage having done nothing.
    const target = stages.findIndex((stage) => stage.kind === 'ai_interview');
    if (target < 0) return;

    // One decision at a time, exactly as the Advance button makes them. The
    // demo's role uses the default five stages, so in practice this is the
    // single Bronze → Silver move a recruiter now makes.
    let at = pipeline.currentStageKey;
    while (stages.findIndex((stage) => stage.key === at) < target) {
      const next = nextStageKey(stages, at);
      if (!next) return;
      const moved = await advancePipeline({ ...pipeline, currentStageKey: at }, {
        tenantId: o.tenantId, toStageKey: next, actorId: o.userId, trigger: 'demo.provisioned',
      });
      if (!moved.applied) {
        logger.error({ candidateId: o.candidateId, stage: at, because: moved.because }, 'Demo sandbox could not move its candidate to the AI round');
        return;
      }
      at = moved.transition.to;
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), candidateId: o.candidateId },
      'Demo sandbox could not walk its candidate to the AI round',
    );
  }
}

export async function provisionDemoTenant(input: { name: string; email: string; company: string; now?: Date }): Promise<ProvisionedDemoTenant> {
  const now = input.now ?? new Date();
  // Drawn before the transaction: the catalogue is global, not sandbox data.
  const interviewer = await assignInterviewer('random');
  const storyInterviewer = await demoStoryInterviewer(interviewer);
  const provisioned = await prisma.$transaction(async (tx) => {
    // Default policy and persona: the demo shows the product as a customer gets it.
    const tenant = await tx.tenant.create({ data: { name: `${input.company} (demo)`, slug: await uniqueTenantSlug(tx as PrismaClient, input.company), isDemo: true, demoExpiresAt: new Date(now.getTime() + TENANT_TTL_MS) } });
    // The visitor's address stays on the grant and the sample candidate; the
    // login gets its own, so a demo never holds (or collides with) a real account's address.
    const user = await tx.user.create({ data: { tenantId: tenant.id, email: demoLoginEmail(), name: input.name, passwordHash: hashPassword(randomBytes(32).toString('base64url')), role: DEMO_ROLE, tourCompletedAt: null } });
    const extraction = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer');
    // The scorecard a hiring manager approved, not the raw extraction (seed/demoStory.ts).
    const roleProfile = curateDemoScorecard(extraction.profile);
    const role = await tx.role.create({ data: { tenantId: tenant.id, catalogRoleId: await demoCatalogRole(tx as PrismaClient), title: extraction.title, level: extraction.level, location: extraction.location, employmentType: extraction.employmentType, sourceType: 'paste', sourceText: DEMO_JD, status: 'approved', createdById: user.id } });
    const scorecard = await tx.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(roleProfile), approvedById: user.id, approvedAt: now } });
    const resume = visitorResume(input.name, input.email);
    const candidate = await tx.candidate.create({ data: { tenantId: tenant.id, roleId: role.id, fullName: input.name, email: input.email, emailNormalized: normalizeEmail(input.email), phone: '' } });
    const profile = normalizeProfile(resume);
    const { fit } = computeFitScore(profile, resume, roleProfile);
    await tx.candidateProfileVersion.create({ data: { candidateId: candidate.id, version: 1, rawText: resume, profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit) } });
    const plan = buildInterviewPlan({ role: roleProfile, fit, durationMinutes: 45, language: 'en', modules: [] });
    // INVITED with no consent recorded: the visitor meets the consent step exactly
    // as a candidate would, which is part of what the demo is showing — including
    // the named AI disclosure, without which consent is refused.
    const session = await tx.interviewSession.create({
      data: {
        tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id, state: 'INVITED', provider: 'hosted', language: 'en', durationMinutes: 45,
        personaJson: JSON.stringify({ interviewerId: interviewer.interviewerId, name: interviewer.name, tone: 'warm' }),
        consentJson: JSON.stringify({ disclosureText: composeDisclosure(interviewer.name, DEFAULT_DISCLOSURE_BODY), recordingRequested: false, humanReviewRequired: true }),
      },
    });
    await tx.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
    const invitationToken = mintInvitationToken();
    await tx.invitation.create({ data: { sessionId: session.id, ...invitationSecretColumns(invitationToken), status: 'sent', sentAt: now, expiresAt: new Date(now.getTime() + TENANT_TTL_MS) } });
    await tx.roleAssignment.create({ data: { roleId: role.id, userId: user.id, relation: 'owner' } });
    await tx.candidateAssignment.create({ data: { candidateId: candidate.id, userId: user.id, relation: 'owner' } });
    const story = await seedDemoStory(tx as PrismaClient, { tenantId: tenant.id, userId: user.id, roleId: role.id, scorecardId: scorecard.id, profile: roleProfile, interviewer: storyInterviewer, now });
    return { tenantId: tenant.id, userId: user.id, invitationToken, sessionId: session.id, roleId: role.id, scorecardId: scorecard.id, candidateId: candidate.id, story };
  // The story is some sixty rows (a transcript, an assessment, two artifacts);
  // on a busy box that outran Prisma's five-second default and left the visitor
  // with no sandbox and no error. Atomic still: all of it lands, or none.
  }, { timeout: PROVISION_TIMEOUT_MS, maxWait: PROVISION_TIMEOUT_MS });
  // After the commit, through the product's own moves. Both candidates end at
  // Silver, the round the AI conducts, because that is where a recruiter who
  // read their CV would have put them.
  //
  // What the visitor then finds waiting is Priya's assessment: her interview is
  // done and nobody has read it, so it is the one row in "Needs you" — and
  // recording that verdict is what carries her to Gold and strikes her Silver
  // certificate. Their own sample candidate stands at the same round with an
  // unopened invitation, which is the interview they can go and sit themselves.
  //
  // Priya used to be staged at Gold, and it was a dead end: she had been
  // carried there by an event, so no badge was ever struck, and there was
  // nothing left for the visitor to promote her to but Diamond. The demo now
  // shows the decision instead of its aftermath.
  const { tenantId, userId, roleId } = provisioned;
  await walkToAiRound({ tenantId, userId, roleId, candidateId: provisioned.story.candidateId });
  await walkToAiRound({ tenantId, userId, roleId, candidateId: provisioned.candidateId });
  return provisioned;
}

/** A login address no real person can hold, so a sandbox user never takes the visitor's. */
function demoLoginEmail(): string { return `demo+${randomBytes(8).toString('hex')}@demo.questor.invalid`; }

/**
 * What a purged grant keeps of the address: a keyed hash, so one grant per
 * address still holds without keeping the address itself.
 */
function anonymisedEmail(email: string): string { return `anon:${createHmac('sha256', config.authSecret).update(`demo-grant:${email}`).digest('hex')}`; }
function isAnonymised(grant: Pick<DemoGrant, 'email'>): boolean { return grant.email.startsWith('anon:'); }

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
  const found = await prisma.demoGrant.findFirst({ where: { email: { in: [email, anonymisedEmail(email)] } } });
  // A purged grant kept only a hash of the address; the visitor has just told
  // us who they are again, so the grant can reach them again.
  const existing = found && isAnonymised(found)
    ? await prisma.demoGrant.update({ where: { id: found.id }, data: { email, name: input.name, company: input.company } })
    : found;
  if (existing?.status === 'sent') {
    // A lost link is re-sent (as a new one), but at most once in ten minutes.
    const live = existing.linkExpiresAt && existing.linkExpiresAt > now && existing.tenantId;
    if (live && existing.updatedAt.getTime() > now.getTime() - RESEND_EVERY_MS) return;
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
    grant = await prisma.demoGrant.create({ data: { name: input.name, email, company: input.company, status: 'sent', linkTokenHash: hashDemoToken(token), linkExpiresAt: new Date(now.getTime() + LINK_TTL_MS), tenantId: provisioned.tenantId, userId: provisioned.userId, requestIpHash: '' } });
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
  await prisma.user.update({ where: { id: grant.user.id }, data: { tourCompletedAt: null, role: DEMO_ROLE } });
  // The sample interview's candidate link lives exactly as long as the demo:
  // a copied link must not keep a sandbox interview (and its speech) running.
  await expireDemoInterviewLinks(grant.tenant.id, grant.sessionEndsAt);
  // `pv` stamps the session generation, as every other issued session does.
  // A demo account's is always 0 — nothing ever changes its password — so
  // leaving it out happened to work; stating it means this does not quietly
  // become the one session that survives a revocation.
  const holder = await prisma.user.findUniqueOrThrow({ where: { id: grant.user.id }, select: { sessionsEpoch: true } });
  const claims: AuthClaims = { userId: grant.user.id, tenantId: grant.tenant.id, role: DEMO_ROLE, email: grant.user.email, demo: true, demoGrantId: grant.id, pv: holder.sessionsEpoch };
  // Cookie only: a bearer token in the body is readable by any script on the page.
  issueSession(res, claims, { ttlSeconds: SESSION_TTL_SECONDS });
  await logAudit({ tenantId: grant.tenant.id, actorType: 'system', actorId: grant.user.id, action: 'demo.redeemed', entityType: 'DemoGrant', entityId: grant.id });
  return { user: { id: grant.user.id, name: grant.user.name, email: grant.user.email, role: DEMO_ROLE, tourCompletedAt: null }, tenant: { id: grant.tenant.id, name: grant.tenant.name, region: grant.tenant.region, slug: grant.tenant.slug, isDemo: true }, sessionEndsAt: grant.sessionEndsAt.toISOString() };
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
    if (isAnonymised(grant)) return;
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
    // The decision token is kept so the operator's page can show "decided";
    // decisionExpiresAt now marks when the decline lapses and the visitor may
    // ask the operator again.
    const changed = await prisma.demoGrant.updateMany({ where: { id: row.id, status: 'reaccess_requested' }, data: { status: 'declined', decisionExpiresAt: new Date(now.getTime() + DECLINE_COOLDOWN_MS) } });
    if (changed.count !== 1) return false;
    await getEmail().send(renderDemoDeclinedEmail({ to: row.email, name: row.name }));
    if (row.tenantId) await logAudit({ tenantId: row.tenantId, actorType: 'system', actorId: 'demo-decision', action: 'demo.declined', entityType: 'DemoGrant', entityId: row.id });
    return true;
  }
  const linkToken = mintDemoToken();
  const sandbox = await ensureSandbox(row, now);
  const changed = await prisma.demoGrant.updateMany({ where: { id: row.id, status: 'reaccess_requested' }, data: { status: 'sent', linkTokenHash: hashDemoToken(linkToken), linkExpiresAt: new Date(now.getTime() + LINK_TTL_MS), consumedAt: null, sessionEndsAt: null, tenantId: sandbox.tenantId, userId: sandbox.userId } });
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

/**
 * The expiry for an invitation sent from this session: unchanged for a real
 * organisation, never later than the demo session's end for a demo.
 */
export async function demoInvitationExpiry(auth: Pick<AuthClaims, 'demo' | 'demoGrantId'>, proposed: Date): Promise<Date> {
  if (auth.demo !== true || !auth.demoGrantId) return proposed;
  const grant = await prisma.demoGrant.findUnique({ where: { id: auth.demoGrantId }, select: { sessionEndsAt: true } });
  const ends = grant?.sessionEndsAt ?? new Date();
  return ends < proposed ? ends : proposed;
}

/** Candidate links in a sandbox stop working at `at`. */
export async function expireDemoInterviewLinks(tenantId: string, at: Date): Promise<void> {
  await prisma.invitation.updateMany({ where: { session: { tenantId, tenant: { isDemo: true } } }, data: { expiresAt: at } });
}

export async function assertNotDemoTenant(tenantId: string, message = DEMO_READ_ONLY_MESSAGE): Promise<void> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isDemo: true } });
  if (tenant?.isDemo) throw new HttpError(403, message);
}

/** What the sandbox starts with: the role, Priya and the visitor, and their two interviews. */
const DEMO_SEEDED = { roles: 1, candidates: 2, interviews: 2 } as const;
/** What the visitor may add on top (owner's decision, 2026-09-24). Also shown on the tour's closing card, from GET /demo/status. */
export const DEMO_ADDED_CAPS = { roles: 2, candidates: 3, interviews: 3 } as const;

const IN_WORDS = ['no', 'one', 'two', 'three', 'four', 'five'] as const;

/** The cap, refused the way the demo speaks: a description of the sandbox, not an error. */
function demoLimitMessage(kind: 'roles' | 'candidates' | 'interviews', pending: boolean): string {
  const added = DEMO_ADDED_CAPS[kind];
  const head = `That's the demo's limit: a demo can add up to ${IN_WORDS[added] ?? String(added)} ${kind}, and this sandbox already has them.`;
  return pending ? `${head} If one is still being created, give it a moment.` : head;
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
  const cap = DEMO_SEEDED[kind] + DEMO_ADDED_CAPS[kind];
  // What the DEMO ITSELF created does not count against what the VISITOR may
  // create. Observer mode provisions a written candidate and a session of its
  // own; without this, watching an interview would silently cost the visitor
  // one of the interviews they are allowed to add.
  const ours = await prisma.demoInterviewRun.findMany({ where: { tenantId }, select: { sessionId: true } });
  const ourSessionIds = ours.map((r) => r.sessionId);
  const count = kind === 'roles'
    ? await prisma.role.count({ where: { tenantId } })
    : kind === 'candidates'
      ? await prisma.candidate.count({ where: { tenantId, interviews: { none: { id: { in: ourSessionIds } } } } })
      : await prisma.interviewSession.count({ where: { tenantId, id: { notIn: ourSessionIds } } });
  if (count >= cap) throw new HttpError(409, demoLimitMessage(kind, false));
  for (let slot = count; slot < cap; slot += 1) {
    const verdict = await consume('demo-cap', `${tenantId}:${kind}:${slot}`, CAP_SLOT_HOLD_MS, 1, { failClosed: true });
    if (verdict.allowed) return;
    if (verdict.reason === 'unavailable') throw new HttpError(503, 'The demo is briefly unavailable. Please try again shortly.');
  }
  throw new HttpError(409, demoLimitMessage(kind, true));
}

export async function purgeExpiredDemoTenants(now = new Date()): Promise<number> {
  const tenants = await prisma.tenant.findMany({ where: { isDemo: true, demoExpiresAt: { lte: now } }, select: { id: true } });
  const tenantIds = tenants.map((t) => t.id);
  if (tenantIds.length === 0) return 0;
  await prisma.$transaction(async (tx) => {
    // The visitor's details go with the sandbox. Kept only where they are still
    // needed to reach the visitor: a grant awaiting the operator's decision, and
    // an unused link that still works (asking again from it re-issues by email).
    const grants = await tx.demoGrant.findMany({
      where: { tenantId: { in: tenantIds }, status: { not: 'reaccess_requested' }, NOT: { status: 'sent', linkExpiresAt: { gt: now } } },
      select: { id: true, email: true },
    });
    for (const g of grants) {
      if (!g.email.startsWith('anon:')) await tx.demoGrant.update({ where: { id: g.id }, data: { name: '', company: '', email: anonymisedEmail(g.email), requestIpHash: '' } });
    }
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
    await tx.candidateFeedbackEmail.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.reviewDifference.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.transcriptRead.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.humanReview.deleteMany({ where: { assessment: { sessionId: { in: sessionIds } } } });
    await tx.assessmentVersion.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.candidateFeedbackOptIn.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidateHumanRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidateFeedbackOptInRequest.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.turn.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.invitation.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.interviewPlanVersion.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.libraryUsage.deleteMany({ where: { interviewSessionId: { in: sessionIds } } });
    await tx.integrityEvent.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.identityCodeChallenge.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await tx.artifact.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.modelExecution.deleteMany({ where: { sessionId: { in: sessionIds } } });
    // The demo interview's own rows. Its feedback goes with the sandbox like
    // everything else the visitor produced: the owner reads it inside the
    // seven days the sandbox lives, and after that a prospect's opinion of us
    // is not a thing we keep. DemoSpendDay is deliberately NOT here — it is a
    // date and a number, belongs to no tenant, and a sandbox retired early
    // must not hand its spend back to the day's ceiling.
    await tx.demoFeedback.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.demoModelSpend.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.demoInterviewRun.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.observationSegment.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.observationParticipant.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.roundObservation.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.interviewRound.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidatePipeline.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.roleAssignment.deleteMany({ where: { role: { tenantId: { in: tenantIds } } } });
    await tx.candidateAssignment.deleteMany({ where: { candidate: { tenantId: { in: tenantIds } } } });
    await tx.candidateAtsLink.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.atsRequisitionImport.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.atsConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.interviewSession.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidateImportRow.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidateImportBatch.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.candidate.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.roleScorecardVersion.deleteMany({ where: { role: { tenantId: { in: tenantIds } } } });
    await tx.role.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.orgCompetency.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.auditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await tx.tenant.deleteMany({ where: { id: { in: tenantIds }, isDemo: true } });
  });
  for (const tenantId of tenantIds) logger.info({ tenantId }, 'Purged expired demo tenant');
  return tenantIds.length;
}
