import type { Candidate, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { assertCanAccessRole, assignCandidate } from './access.js';
import { assertDemoCreationCap } from './demoAccess.js';
import { assertRoleOpen } from './roleOpen.js';
import { findApplicationOnRole, inApplicationTransaction } from './candidateReuse.js';
import { logAudit } from './audit.js';
import { emitEvent } from './webhooks.js';
import { notePipelineEvent } from './pipelineAutonomy.js';
import { normalizeEmail } from './userEmail.js';
import { resumeScoringFor, storeResumeProfile } from './resumeProfile.js';
import type { AuthClaims } from './auth.js';

/**
 * The two steps of adding a person to a role, shared by Add candidate
 * (POST /candidates, then POST /candidates/:id/resume) and bulk import, so
 * both write the same rows, audit events, webhooks and pipeline moves.
 */

export interface NewApplication {
  readonly roleId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone?: string;
  readonly linkedinUrl?: string;
}

export type CreateApplicationResult =
  | { readonly kind: 'created'; readonly candidate: Candidate }
  | { readonly kind: 'exists'; readonly candidateId: string };

export interface CreateApplicationOptions {
  /** Runs inside the creating transaction, so a caller's own bookkeeping commits with the row. */
  readonly onCreated?: (tx: Prisma.TransactionClient, candidate: Candidate) => Promise<void>;
}

/**
 * A new application for one person on one role, or the one already there.
 *
 * The target role is scoped, not merely tenant-matched: attaching a candidate
 * to someone else's requisition would otherwise plant a record inside a
 * pipeline the caller cannot see but the role's owners can. The duplicate
 * check and the row (with its owner) commit together, so two identical adds
 * at once cannot both pass it.
 */
export async function createApplication(auth: AuthClaims, input: NewApplication, opts: CreateApplicationOptions = {}): Promise<CreateApplicationResult> {
  await assertDemoCreationCap(auth.tenantId, 'candidates');
  await assertCanAccessRole(auth, input.roleId);
  await assertRoleOpen(input.roleId);
  const tenantId = auth.tenantId;
  const emailNormalized = normalizeEmail(input.email);
  const outcome = await inApplicationTransaction(async (tx) => {
    const existing = await findApplicationOnRole(tx, { tenantId, roleId: input.roleId, emailNormalized });
    if (existing) return { kind: 'exists' as const, candidateId: existing.id };
    const made = await tx.candidate.create({
      data: {
        tenantId, roleId: input.roleId, fullName: input.fullName, email: input.email, emailNormalized,
        phone: input.phone ?? '', linkedinUrl: input.linkedinUrl ?? '',
      },
    });
    // Role assignment alone would already cover this candidate, but the explicit
    // grant survives the creator later being unassigned from the role.
    await assignCandidate(made.id, auth.userId, 'owner', tx);
    if (opts.onCreated) await opts.onCreated(tx, made);
    return { kind: 'created' as const, candidate: made };
  });
  if (outcome.kind === 'exists') return outcome;
  const { candidate } = outcome;
  await logAudit({ tenantId, actorId: auth.userId, actorType: 'user', action: 'candidate.created', entityType: 'Candidate', entityId: candidate.id });
  // Onboarding starts the candidate's journey at Participation on its own.
  await notePipelineEvent({ tenantId, candidateId: candidate.id, roleId: candidate.roleId, event: 'candidate.onboarded', trigger: 'candidate.created' });
  return outcome;
}

export interface ResumeInput {
  readonly rawText: string;
  readonly filename: string;
  readonly contentType: string;
}

export interface AttachResumeOptions {
  /** Runs inside the storing transaction, so a caller's own bookkeeping commits with the profile. */
  readonly onStored?: (tx: Prisma.TransactionClient) => Promise<void>;
}

// Above Prisma's 5 s default: the evidence graph is written row by row.
const STORE_TIMEOUT_MS = 20_000;

/**
 * Parse a resume onto an application: a new profile version scored against
 * the role, its evidence graph and the resume record. An analysed profile is
 * what the Bronze review works from, so the pipeline moves there.
 */
export async function attachResume(
  auth: AuthClaims,
  candidate: { readonly id: string; readonly roleId: string | null },
  resume: ResumeInput,
  opts: AttachResumeOptions = {},
) {
  const scoring = await resumeScoringFor(candidate.roleId);
  const stored = await prisma.$transaction(async (tx) => {
    const result = await storeResumeProfile(tx, { tenantId: auth.tenantId, candidateId: candidate.id, ...resume, scoring });
    if (opts.onStored) await opts.onStored(tx);
    return result;
  }, { timeout: STORE_TIMEOUT_MS });
  await logAudit({ tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user', action: 'candidate.parsed', entityType: 'Candidate', entityId: candidate.id });
  await emitEvent(auth.tenantId, 'candidate.parsed', { candidateId: candidate.id, fit: stored.fit.overall });
  await notePipelineEvent({ tenantId: auth.tenantId, candidateId: candidate.id, roleId: candidate.roleId, event: 'candidate.profiled', trigger: 'candidate.parsed' });
  return stored;
}
