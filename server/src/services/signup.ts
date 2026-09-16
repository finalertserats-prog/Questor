import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient, SignupRequest } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import { hashPassword } from './auth.js';
import { logAudit } from './audit.js';
import { getEmail } from '../providers/email/index.js';
import { renderSignupAcknowledgementEmail, renderSignupOperatorEmail, renderSignupWelcomeEmail } from '../providers/email/signupEmail.js';

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
  now?: Date;
}

export async function createSignupRequest(input: CreateSignupInput): Promise<void> {
  if (!config.signupApproverEmail) {
    logger.error('SIGNUP_APPROVER_EMAIL is not set; refusing to accept a signup nobody can approve.');
    throw new HttpError(503, 'Signup is temporarily unavailable.');
  }

  const now = input.now ?? new Date();
  const token = mintSignupDecisionToken();
  const organisation = input.mode === 'new-org' ? input.organisationName! : input.orgCode!;
  await prisma.signupRequest.create({
    data: {
      name: input.name,
      email: input.email.toLowerCase(),
      mode: input.mode,
      organisationName: input.mode === 'new-org' ? input.organisationName! : null,
      orgSlug: input.mode === 'join' ? input.orgCode!.toLowerCase() : null,
      passwordHash: hashPassword(input.password),
      decisionTokenHash: hashSignupDecisionToken(token),
      expiresAt: new Date(now.getTime() + SIGNUP_DECISION_TTL_DAYS * DAY_MS),
    },
  });

  const decisionPath = `/signup/decision/${token}`;
  await getEmail().send(renderSignupOperatorEmail({
    to: config.signupApproverEmail,
    name: input.name,
    email: input.email.toLowerCase(),
    organisation,
    mode: input.mode,
    approveUrl: webUrl(decisionPath),
    declineUrl: webUrl(decisionPath),
  }));
  await getEmail().send(renderSignupAcknowledgementEmail({ to: input.email.toLowerCase(), name: input.name }));
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

export function signupApplicant(row: SignupRequest) {
  return {
    name: row.name,
    email: row.email,
    organisation: row.mode === 'new-org' ? row.organisationName ?? '' : row.orgSlug ?? '',
    mode: row.mode,
  };
}

async function auditSignupDecision(row: SignupRequest, action: string, actorId: string, after: unknown) {
  const tenantId = row.createdTenantId
    ?? (row.orgSlug ? (await prisma.tenant.findUnique({ where: { slug: row.orgSlug }, select: { id: true } }))?.id : null);
  if (!tenantId) return;
  await logAudit({
    tenantId,
    actorType: actorId === 'signup-link' ? 'system' : 'user',
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
}): Promise<{ transitioned: boolean; approvedUserId?: string }> {
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
    await auditSignupDecision(row, 'signup.declined', opts.actorId, { reason: 'operator_declined', decidedAt: now });
    return { transitioned: true };
  }

  let createdUserId: string | undefined;
  let createdTenantId: string | undefined;
  let declinedReason: string | null = null;

  const transitioned = await prisma.$transaction(async (tx) => {
    const claimed = await tx.signupRequest.updateMany({
      where: { id: row.id, status: 'PENDING', expiresAt: { gt: now } },
      data: { status: 'APPROVED', decidedAt: now, decidedBy: opts.actorId },
    });
    if (claimed.count === 0) return false;

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
        data: { name: row.organisationName ?? `${row.name}'s Org`, slug: await uniqueTenantSlug(tx as PrismaClient, row.organisationName ?? row.name) },
      });
      const user = await tx.user.create({
        data: { tenantId: tenant.id, email: row.email, name: row.name, passwordHash: row.passwordHash, role: 'admin' },
      });
      createdTenantId = tenant.id;
      createdUserId = user.id;
    }

    await tx.signupRequest.update({ where: { id: row.id }, data: { createdTenantId, createdUserId } });
    return true;
  });

  if (!transitioned) return { transitioned: false };
  const finalRow = { ...row, createdTenantId: createdTenantId ?? row.createdTenantId, createdUserId: createdUserId ?? row.createdUserId };
  await auditSignupDecision(finalRow, declinedReason ? 'signup.approval_declined' : 'signup.approved', opts.actorId, {
    decidedAt: now,
    createdTenantId,
    createdUserId,
    reason: declinedReason ?? undefined,
  });
  if (createdUserId) {
    await getEmail().send(renderSignupWelcomeEmail({ to: row.email, name: row.name, signInUrl: webUrl('/login') }));
  }
  return { transitioned: true, approvedUserId: createdUserId };
}
