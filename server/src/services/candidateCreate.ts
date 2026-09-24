import type { Candidate, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { assertCanAccessRole, assignCandidate } from './access.js';
import { assertDemoCreationCap } from './demoAccess.js';
import { assertRoleOpen } from './roleOpen.js';
import { findApplicationOnRole, inApplicationTransaction } from './candidateReuse.js';
import { logAudit } from './audit.js';
import { emitEvent } from './webhooks.js';
import { notePipelineEvent } from './pipelineAutonomy.js';
import { normalizeEmail } from './userEmail.js';
import { cvFactsFor, resumeScoringFor, storeResumeProfile } from './resumeProfile.js';
import { awardBronze, isAwardConflict, noteAwards } from './candidateAwards.js';
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
  // Reading the CV can call the configured model; it happens here, before the
  // transaction, so a slow provider cannot hold a write transaction open.
  const facts = await cvFactsFor(resume.rawText);
  // Bronze is earned here, not by any move: the CV has been read against an
  // approved scorecard and a fit computed, and no person did either. Struck in
  // the same transaction as the profile it is evidence of — a badge whose
  // reading rolled back would certify nothing. A reading measured against an
  // unapproved draft strikes nothing at all.
  const writeProfile = (strikeBronze: boolean) => prisma.$transaction(async (tx) => {
    const result = await storeResumeProfile(tx, { tenantId: auth.tenantId, candidateId: candidate.id, ...resume, scoring, facts });
    if (opts.onStored) await opts.onStored(tx);
    const struck = strikeBronze && candidate.roleId
      ? await awardBronze(tx, {
        tenantId: auth.tenantId, candidateId: candidate.id, roleId: candidate.roleId,
        fitScoreJson: JSON.stringify(result.fit),
      })
      : [];
    return { stored: result, awards: struck };
  }, { timeout: STORE_TIMEOUT_MS });

  // Two uploads for the same person landing together both find no Bronze and
  // both try to strike one; the loser's insert fails the tier key and — on
  // Postgres, where a failed statement aborts the transaction — would take the
  // whole profile write with it. A resume upload must not fail because a badge
  // the candidate already holds could not be struck twice, so the profile is
  // written again without the attempt. Nothing was committed by the first try,
  // so this leaves one profile version, not two.
  const { stored, awards } = await writeProfile(true).catch((err: unknown) => {
    if (!isAwardConflict(err)) throw err;
    logger.info({ candidateId: candidate.id }, 'Bronze was struck by a concurrent upload; storing this profile version without it');
    return writeProfile(false);
  });
  await logAudit({ tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user', action: 'candidate.parsed', entityType: 'Candidate', entityId: candidate.id });
  // Bronze carries no person's name, so the trail records it as the system's
  // act. That absence is the fact the certificate exists to make visible.
  await noteAwards({ tenantId: auth.tenantId, actorId: null, candidateId: candidate.id, awards });
  await emitEvent(auth.tenantId, 'candidate.parsed', { candidateId: candidate.id, fit: stored.fit.overall });
  await notePipelineEvent({ tenantId: auth.tenantId, candidateId: candidate.id, roleId: candidate.roleId, event: 'candidate.profiled', trigger: 'candidate.parsed' });
  return stored;
}
