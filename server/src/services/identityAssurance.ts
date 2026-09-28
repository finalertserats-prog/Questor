import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { getEmail } from '../providers/email/index.js';
import {
  assuranceLevelOf, checksFor, readIdentityCheck, type AssuranceLevel, type IdentityCheckRecord,
} from '../domain/identityAssurance.js';
import { isIdentityConfirmed, maskEmail } from './identityCode.js';
import { demoRecipientBlocked } from './demoPolicy.js';

/** Candidate-facing: why the room will not open yet, and what to do about it. */
export const IDENTITY_CODE_REQUIRED_MESSAGE = 'Before the interview starts, please enter the code we emailed you. Go back to your invitation link to get it.';

export async function tenantAssuranceLevel(tenantId: string): Promise<AssuranceLevel> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
  return assuranceLevelOf(parseJsonOptional<Record<string, unknown>>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: tenantId, field: 'policyJson' }));
}

/**
 * Whether a code sent now would reach the candidate. A deployment running
 * without mail on purpose (ALLOW_UNDELIVERED_EMAIL, links sent by hand) cannot
 * deliver one, and demanding it would lock every candidate out of their
 * interview; the check is then recorded as not run, and the review panel says
 * so. The same holds for the console provider on a developer's machine and in
 * the end-to-end suite: try the code step locally with SMTP configured.
 */
export function emailCodeDeliverable(): boolean {
  return getEmail().delivers;
}

/** What a consent given now commits the candidate to. */
export async function identityCheckForConsent(tenantId: string, candidateEmail: string): Promise<IdentityCheckRecord> {
  const level = await tenantAssuranceLevel(tenantId);
  if (!checksFor(level).emailCode || !emailCodeDeliverable()) return { level, method: 'none', reason: 'email_not_configured' };
  // A demo sandbox mails only the visitor, so a made-up candidate address
  // could never receive the code and the visitor would be stuck.
  if (await demoRecipientBlocked(tenantId, candidateEmail)) return { level, method: 'none', reason: 'demo_address' };
  return { level, method: 'email_code', channel: 'email' };
}

function consentOf(session: { id: string; consentJson: string }): Record<string, unknown> {
  return parseJsonStrict<Record<string, unknown>>(session.consentJson, { model: 'InterviewSession', id: session.id, field: 'consentJson' });
}

/** The check recorded with this session's consent, or null for a consent that predates identity checks. */
export function recordedIdentityCheck(session: { id: string; consentJson: string }): IdentityCheckRecord | null {
  return readIdentityCheck(consentOf(session));
}

/**
 * The gate before an interview goes live. Called from the engine's start, so
 * the socket and the HTTP fallback refuse alike. Only a consent that recorded
 * the email code needs one: interviews agreed to before the check existed, and
 * deployments that cannot deliver mail, go ahead as before.
 */
export async function assertIdentityConfirmed(session: { id: string; consentJson: string }): Promise<void> {
  if (recordedIdentityCheck(session)?.method !== 'email_code') return;
  if (await isIdentityConfirmed(session.id)) return;
  throw new HttpError(409, IDENTITY_CODE_REQUIRED_MESSAGE, 'identity_code_required');
}

export interface PortalIdentityView {
  readonly required: boolean;
  readonly channel: 'email';
  readonly destination: string;
  readonly verified: boolean;
}

/**
 * What the portal tells the candidate. Before consent it is what consenting
 * now would require (so the consent screen can say so); after, it is what
 * their consent recorded.
 */
export async function portalIdentityView(session: {
  id: string; tenantId: string; consentJson: string; candidate: { email: string };
}, consented: boolean): Promise<PortalIdentityView> {
  const check = consented ? recordedIdentityCheck(session) : await identityCheckForConsent(session.tenantId, session.candidate.email);
  return {
    required: check?.method === 'email_code',
    channel: 'email',
    destination: maskEmail(session.candidate.email),
    verified: await isIdentityConfirmed(session.id),
  };
}
