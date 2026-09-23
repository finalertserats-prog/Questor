import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient, SignupRequest } from '@prisma/client';
import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import { hashPassword } from './auth.js';
import { logAudit } from './audit.js';
import { getEmail } from '../providers/email/index.js';
import { isReservedOperatorEmail } from '../middleware/platformOperator.js';
import { renderSignupAcknowledgementEmail, renderSignupOperatorEmail, renderSignupWelcomeEmail } from '../providers/email/signupEmail.js';
import { guardSignupRequest } from './signupAbuse.js';
import { emailDomainOf, orgNameKey } from '../domain/orgOnboarding.js';

export const SIGNUP_DECISION_TTL_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{24,128}$/;

type SignupMode = 'new-org' | 'join';
type Decision = 'approve' | 'decline';

export function mintSignupDecisionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSignupDecisionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function webUrl(path: string): string {
  return `${config.webOrigin.replace(/\/+$/, '')}${path}`;
}

function slugify(value: string): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return base || 'org';
}

async function uniqueTenantSlug(tx: PrismaClient, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`.slice(0, 40);
    const exists = await tx.tenant.findUnique({ where: { slug }, select: { id: true } });
    if (!exists) return slug;
  }
  return `${base.slice(0, 27)}-${randomBytes(4).toString('hex')}`;
}

export interface CreateSignupInput {
  name: string;
  email: string;
  password: string;
  mode: SignupMode;
  organisationName?: string;
  orgCode?: string;
  /** Where the organisation hires from, reusing the catalog's own regions. */
  regionCode?: string;
  orgSize?: string;
  /** Catalog domain slugs — the business areas this organisation hires for. */
  businessAreas?: readonly string[];
  now?: Date;
}

export async function createSignupRequest(input: CreateSignupInput): Promise<void> {
  if (!config.signupApproverEmail) {
    logger.error('SIGNUP_APPROVER_EMAIL is not set; refusing to accept a signup nobody can approve.');
    throw new HttpError(503, 'Signup is temporarily unavailable.');
  }

  const now = input.now ?? new Date();
  const email = input.email.toLowerCase();

  // Before anything is written or emailed. A refusal here costs one count
  // query; letting it through costs a row in a person's queue.
  const verdict = await guardSignupRequest({
    email, mode: input.mode, organisationName: input.organisationName, now,
  });
  if (verdict.kind === 'refuse') throw new HttpError(verdict.status, verdict.message);
  // Answered exactly as success is answered, with nothing created: see
  // services/signupAbuse.ts for why saying anything else would be an answer.
  //
  // The acknowledgement goes out all the same. Saying nothing back to the
  // applicant was the loudest signal of the lot: anyone probing a name with
  // their own address learnt it was in cooldown from the email that never
  // arrived, which is exactly the question the identical response exists to
  // refuse. The operator's notice is not sent, because there is no request for
  // them to read; that one is not observable from outside.
  if (verdict.kind === 'silently-drop') {
    try {
      await getEmail().send(renderSignupAcknowledgementEmail({ to: email, name: input.name }));
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Signup acknowledgement email could not be sent');
    }
    return;
  }

  const token = mintSignupDecisionToken();
  const organisation = input.mode === 'new-org' ? input.organisationName! : input.orgCode!;
  const created = await prisma.signupRequest.create({
    data: {
      name: input.name,
      email,
      mode: input.mode,
      organisationName: input.mode === 'new-org' ? input.organisationName! : null,
      orgSlug: input.mode === 'join' ? input.orgCode!.toLowerCase() : null,
      passwordHash: hashPassword(input.password),
      decisionTokenHash: hashSignupDecisionToken(token),
      expiresAt: new Date(now.getTime() + SIGNUP_DECISION_TTL_DAYS * DAY_MS),
      regionCode: input.mode === 'new-org' ? input.regionCode ?? null : null,
      orgSize: input.mode === 'new-org' ? input.orgSize ?? null : null,
      businessAreasJson: JSON.stringify(input.mode === 'new-org' ? input.businessAreas ?? [] : []),
      orgNameKey: input.mode === 'new-org' && input.organisationName ? orgNameKey(input.organisationName) : null,
      emailDomain: emailDomainOf(email) || null,
    },
  });

  const decisionPath = `/signup/decision/${token}`;
  try {
    await getEmail().send(renderSignupOperatorEmail({
      to: config.signupApproverEmail,
      name: input.name,
      email: input.email.toLowerCase(),
      organisation,
      mode: input.mode,
      approveUrl: webUrl(decisionPath),
      declineUrl: webUrl(decisionPath),
    }));
  } catch (err) {
    // Nobody can decide a request the operator never heard about, and the
    // applicant's retry would only add a second pending row beside this one.
    // Undo the row so the retry is clean, and say so honestly.
    await prisma.signupRequest.delete({ where: { id: created.id } }).catch(() => undefined);
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Signup request withdrawn: the operator email could not be sent');
    throw new HttpError(503, 'Signup is temporarily unavailable.');
  }
  try {
    await getEmail().send(renderSignupAcknowledgementEmail({ to: input.email.toLowerCase(), name: input.name }));
  } catch (err) {
    // The request stands; only the courtesy note failed.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Signup acknowledgement email could not be sent');
  }

  // The request itself, not only the decision on it. Without this the trail
  // started at "an account appeared": what was asked for, and when, had no
  // record, so an approval could not be checked against it afterwards.
  await auditSignupEvent(created, 'signup.requested', 'signup-form', {
    mode: input.mode,
    organisation,
    regionCode: input.mode === 'new-org' ? input.regionCode ?? null : null,
    orgSize: input.mode === 'new-org' ? input.orgSize ?? null : null,
    businessAreas: input.mode === 'new-org' ? input.businessAreas ?? [] : [],
    requestedAt: now,
  });
}

export async function resolveSignupDecision(token: string, now = new Date()): Promise<SignupRequest> {
  if (!TOKEN_SHAPE.test(token)) throw new HttpError(404, 'This signup link is not valid.');
  const tokenHash = hashSignupDecisionToken(token);
  const row = await prisma.signupRequest.findUnique({ where: { decisionTokenHash: tokenHash } });
  if (!row || !hashesMatch(row.decisionTokenHash, tokenHash)) throw new HttpError(404, 'This signup link is not valid.');
  await expireIfPast(row, now);
  return row;
}

/**
 * A PENDING request whose window has closed is settled here, whichever door it
 * came in by. This used to live only on the link path, so an operator acting on
 * the same row from the queue was told it had "already been decided" (409) when
 * in truth nobody had decided anything and the link had merely aged out. Both
 * paths now mark it EXPIRED and say so.
 */
async function expireIfPast(row: SignupRequest, now: Date): Promise<void> {
  if (row.status !== 'PENDING' || row.expiresAt > now) return;
  await prisma.signupRequest.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
  throw new HttpError(410, 'This signup request has expired.');
}

/**
 * The applicant's details, derived: "organisation" is `organisationName` for a
 * new organisation and `orgSlug` for a join, and only this knows which. Typed
 * to the fields it actually reads so the queue endpoint, which selects a subset
 * of the row, can pass what it has without casting the check away.
 */
export function signupApplicant(row: Pick<SignupRequest, 'name' | 'email' | 'mode' | 'organisationName' | 'orgSlug'>) {
  return {
    name: row.name,
    email: row.email,
    organisation: row.mode === 'new-org' ? row.organisationName ?? '' : row.orgSlug ?? '',
    mode: row.mode,
  };
}

/**
 * A signup request has no tenant of its own until it is approved, and the
 * audit log is per-tenant. Recorded against whatever organisation the request
 * touches, falling back to the operator's own: "nowhere" is not an option for
 * a decision a person made.
 */
async function auditSignupEvent(row: SignupRequest, action: string, actorId: string, after: unknown) {
  const tenantId = row.createdTenantId
    ?? (row.orgSlug ? (await prisma.tenant.findUnique({ where: { slug: row.orgSlug }, select: { id: true } }))?.id : null)
    // A declined new-organisation request created nothing and joins nothing,
    // yet a person decided it. It is recorded against the operator's own
    // organisation rather than nowhere.
    ?? (await prisma.user.findUnique({ where: { email: config.signupApproverEmail.toLowerCase() }, select: { tenantId: true } }))?.tenantId
    ?? null;
  if (!tenantId) {
    logger.warn({ action, signupRequestId: row.id }, 'Signup decision could not be audited: no organisation to record it against');
    return;
  }
  await logAudit({
    tenantId,
    actorType: actorId === 'signup-link' || actorId === 'signup-form' ? 'system' : 'user',
    actorId,
    action,
    entityType: 'SignupRequest',
    entityId: row.id,
    after,
  });
}

export async function decideSignupRequest(opts: {
  id?: string;
  token?: string;
  decision: Decision;
  actorId: string;
  now?: Date;
}): Promise<{ transitioned: boolean; approvedUserId?: string; welcomeDelivered?: boolean }> {
  const now = opts.now ?? new Date();
  const row = opts.token
    ? await resolveSignupDecision(opts.token, now)
    : await prisma.signupRequest.findUnique({ where: { id: opts.id! } });
  if (!row) throw new HttpError(404, 'Signup request not found.');
  await expireIfPast(row, now);
  if (row.status !== 'PENDING') return { transitioned: false, approvedUserId: row.createdUserId ?? undefined };

  if (opts.decision === 'decline') {
    // expiresAt is claimed here as well as on approve. Without it the two
    // halves of one state machine disagree: an expired link could still be
    // declined, so whether expiry froze a request depended on which button the
    // operator happened to press.
    const { count } = await prisma.signupRequest.updateMany({
      where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'DECLINED', decidedAt: now, decidedBy: opts.actorId },
    });
    if (count === 0) return { transitioned: false };
    await auditSignupEvent(row, 'signup.declined', opts.actorId, { reason: 'operator_declined', decidedAt: now });
    return { transitioned: true };
  }

  let createdUserId: string | undefined;
  let createdTenantId: string | undefined;
  let declinedReason: string | null = null;
  let grantedAreaSlugs: string[] = [];
  // Asked for but not granted, because the catalog retired the area between
  // the request and the decision. Recorded so the gap has an explanation.
  let droppedAreaSlugs: string[] = [];

  const transitioned = await prisma.$transaction(async (tx) => {
    const claimed = await tx.signupRequest.updateMany({
      where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'APPROVED', decidedAt: now, decidedBy: opts.actorId },
    });
    if (claimed.count === 0) return false;

    // An applicant must never get a platform-owner address: the account would carry the owner's standing.
    if (isReservedOperatorEmail(row.email)) {
      declinedReason = 'email_reserved';
      await tx.signupRequest.update({ where: { id: row.id }, data: { status: 'DECLINED' } });
      return true;
    }
    const existing = await tx.user.findUnique({ where: { email: row.email }, select: { id: true } });
    if (existing) {
      declinedReason = 'email_already_registered';
      await tx.signupRequest.update({ where: { id: row.id }, data: { status: 'DECLINED' } });
      return true;
    }

    if (row.mode === 'join') {
      const tenant = row.orgSlug ? await tx.tenant.findUnique({ where: { slug: row.orgSlug } }) : null;
      if (!tenant) {
        declinedReason = 'organisation_not_found';
        await tx.signupRequest.update({ where: { id: row.id }, data: { status: 'DECLINED' } });
        return true;
      }
      const user = await tx.user.create({
        data: { tenantId: tenant.id, email: row.email, name: row.name, passwordHash: row.passwordHash, role: 'recruiter' },
      });
      createdTenantId = tenant.id;
      createdUserId = user.id;
    } else {
      const tenant = await tx.tenant.create({
        data: {
          name: row.organisationName ?? `${row.name}'s Org`,
          slug: await uniqueTenantSlug(tx as PrismaClient, row.organisationName ?? row.name),
          // What they said on the form, not a default nobody chose. Left at
          // the schema default when the request predates onboarding.
          ...(row.regionCode ? { region: row.regionCode } : {}),
        },
      });
      const user = await tx.user.create({
        data: { tenantId: tenant.id, email: row.email, name: row.name, passwordHash: row.passwordHash, role: 'admin' },
      });
      // The areas they asked for become the areas they browse. Resolved against
      // the live catalog inside the same transaction, so a domain retired
      // between request and approval is dropped rather than failing the
      // approval — the organisation is then simply unscoped, which is the same
      // view every older organisation has.
      const slugs = parseJsonOptional<string[]>(row.businessAreasJson, [], {
        model: 'SignupRequest', id: row.id, field: 'businessAreasJson',
      });
      if (Array.isArray(slugs) && slugs.length > 0) {
        const domains = await tx.catalogDomain.findMany({ where: { slug: { in: slugs }, status: 'active' }, select: { id: true, slug: true } });
        if (domains.length > 0) {
          await tx.tenantBusinessArea.createMany({
            data: domains.map((d) => ({ tenantId: tenant.id, domainId: d.id })),
          });
        }
        // What was granted, not what was asked for. Recording the request's
        // slugs here would have the audit trail say an organisation was set up
        // with an area that had been retired in the meantime and never reached
        // it — a record of the wrong thing is worse than no record.
        grantedAreaSlugs = domains.map((d) => d.slug);
        droppedAreaSlugs = slugs.filter((slug) => !grantedAreaSlugs.includes(slug));
      }
      createdTenantId = tenant.id;
      createdUserId = user.id;
    }

    await tx.signupRequest.update({ where: { id: row.id }, data: { createdTenantId, createdUserId } });
    return true;
  });

  if (!transitioned) return { transitioned: false };
  const finalRow = { ...row, createdTenantId: createdTenantId ?? row.createdTenantId, createdUserId: createdUserId ?? row.createdUserId };
  await auditSignupEvent(finalRow, declinedReason ? 'signup.approval_declined' : 'signup.approved', opts.actorId, {
    decidedAt: now,
    createdTenantId,
    createdUserId,
    reason: declinedReason ?? undefined,
    // What the organisation was set up with, so "who gave them these areas"
    // has an answer from the moment the account exists.
    regionCode: row.regionCode ?? undefined,
    businessAreas: grantedAreaSlugs.length > 0 ? grantedAreaSlugs : undefined,
    businessAreasDropped: droppedAreaSlugs.length > 0 ? droppedAreaSlugs : undefined,
  });
  // The account exists once the transaction above committed. A welcome mail
  // that bounces must not turn that into a 500, which then reads as "already
  // decided" on the operator's retry.
  let welcomeDelivered = false;
  if (createdUserId) {
    try {
      await getEmail().send(renderSignupWelcomeEmail({ to: row.email, name: row.name, signInUrl: webUrl('/login') }));
      welcomeDelivered = true;
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), signupRequestId: row.id }, 'Account created but the welcome email could not be sent');
    }
  }
  return { transitioned: true, approvedUserId: createdUserId, welcomeDelivered };
}
