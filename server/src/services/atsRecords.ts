import type { CandidateAtsLink } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { normalizeEmail } from './userEmail.js';
import { HttpError } from '../middleware/index.js';
import type { AtsRequisition } from '../providers/ats/index.js';
import type { AuthClaims } from './auth.js';
import { assertCanAccessCandidate, assertCanAccessRole, assignCandidate } from './access.js';
import { atsFailure, requireTenantAts, type TenantAts } from './atsConnections.js';
import { logAudit } from './audit.js';
import { assertRoleOpen } from './roleOpen.js';
import { notePipelineEvent } from './pipelineAutonomy.js';
import { findApplicationOnRole, inApplicationTransaction } from './candidateReuse.js';

/**
 * What came from an organisation's ATS, and which ATS record a Questor
 * candidate is.
 *
 * Requisitions are recorded per ATS account, so one is imported once and a
 * repeat import returns the same role. Candidate links are the only target an
 * export uses; a caller can no longer name the ATS candidate to write to.
 */

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

/** A scope refusal (404) on something already imported becomes a 409 that says so; anything else is rethrown. */
function outOfScopeAs(message: string) {
  return (err: unknown): never => {
    if (err instanceof HttpError && err.status === 404) throw new HttpError(409, message);
    throw err;
  };
}

// ---- Requisitions ----

export type RequisitionLookup =
  | { kind: 'new'; ats: TenantAts; requisition: AtsRequisition }
  | { kind: 'existing'; roleId: string };

/**
 * Resolve a requisition for import from the caller's own ATS. An earlier
 * import is found before the ATS is called, so a repeat costs nothing.
 */
export async function lookupRequisition(auth: AuthClaims, externalRequisitionId: string): Promise<RequisitionLookup> {
  const ats = await requireTenantAts(auth.tenantId);
  const existing = await existingImport(auth, ats.connection.atsKey, externalRequisitionId);
  if (existing) return existing;
  const requisition = await ats.client.fetchRequisition(externalRequisitionId).catch((err: unknown) => atsFailure(err, 'requisition'));
  return { kind: 'new', ats, requisition };
}

export async function existingImport(auth: AuthClaims, atsKey: string, externalRequisitionId: string): Promise<RequisitionLookup | null> {
  const row = await prisma.atsRequisitionImport.findUnique({
    where: { atsKey_externalRequisitionId: { atsKey, externalRequisitionId } },
  });
  if (!row) return null;
  // Possible only if the account changed hands between organisations. Nothing
  // about the other import is said.
  if (row.tenantId !== auth.tenantId) {
    throw new HttpError(409, 'This requisition was already imported into Questor and cannot be imported again.');
  }
  await assertCanAccessRole(auth, row.roleId).catch(outOfScopeAs('This requisition has already been imported. Ask an administrator to give you access to its role.'));
  return { kind: 'existing', roleId: row.roleId };
}

// ---- Candidate links ----

export async function findCandidateLink(tenantId: string, candidateId: string, connectionId: string): Promise<CandidateAtsLink | null> {
  return prisma.candidateAtsLink.findUnique({
    where: { tenantId_candidateId_connectionId: { tenantId, candidateId, connectionId } },
  });
}

export function shapeLink(link: CandidateAtsLink) {
  return { externalCandidateId: link.externalCandidateId, source: link.source, createdAt: link.createdAt };
}

const linkedElsewhere = () => new HttpError(409, 'That ATS candidate is already linked to another candidate in Questor.');

/**
 * An admin links a candidate to an ATS record by hand. The id must exist in the
 * organisation's own ATS: a link to a record that is not there would make the
 * next export fail, or worse, land on whoever gets that id later.
 */
export async function setCandidateLink(o: { auth: AuthClaims; candidateId: string; externalCandidateId: string; requestId?: string }) {
  await assertCanAccessCandidate(o.auth, o.candidateId);
  const { connection, client } = await requireTenantAts(o.auth.tenantId);
  await client.fetchCandidate(o.externalCandidateId).catch((err: unknown) => atsFailure(err, 'candidate'));

  const key = { tenantId: o.auth.tenantId, candidateId: o.candidateId, connectionId: connection.id };
  let link: CandidateAtsLink;
  try {
    link = await prisma.candidateAtsLink.upsert({
      where: { tenantId_candidateId_connectionId: key },
      create: { ...key, externalCandidateId: o.externalCandidateId, source: 'manual', createdById: o.auth.userId },
      update: { externalCandidateId: o.externalCandidateId, source: 'manual', createdById: o.auth.userId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw linkedElsewhere();
    throw err;
  }
  // The external id is left out: this row outlives an erasure, the link does not.
  await logAudit({
    tenantId: o.auth.tenantId, actorId: o.auth.userId, actorType: 'user', action: 'candidate.ats_link.set',
    entityType: 'Candidate', entityId: o.candidateId, after: { connectionId: connection.id, source: 'manual' }, requestId: o.requestId,
  });
  return link;
}

export async function removeCandidateLink(o: { auth: AuthClaims; candidateId: string; requestId?: string }): Promise<boolean> {
  await assertCanAccessCandidate(o.auth, o.candidateId);
  const { count } = await prisma.candidateAtsLink.deleteMany({ where: { tenantId: o.auth.tenantId, candidateId: o.candidateId } });
  if (count > 0) {
    await logAudit({
      tenantId: o.auth.tenantId, actorId: o.auth.userId, actorType: 'user', action: 'candidate.ats_link.removed',
      entityType: 'Candidate', entityId: o.candidateId, requestId: o.requestId,
    });
  }
  return count > 0;
}

const importedContactSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40),
});

/**
 * Create a candidate from the organisation's ATS, linked to the record it came
 * from. A repeat import of the same ATS candidate returns the one already made,
 * and so does an import of someone whose address already has an application
 * on the role: that application is linked to the record instead (unless it is
 * already linked to another one), so one person stays one application per role.
 */
export async function importCandidate(o: { auth: AuthClaims; externalCandidateId: string; roleId: string; requestId?: string }) {
  await assertCanAccessRole(o.auth, o.roleId);
  await assertRoleOpen(o.roleId);
  const { connection, client } = await requireTenantAts(o.auth.tenantId);
  const tenantId = o.auth.tenantId;

  const existing = await findLinkByExternalId(tenantId, connection.id, o.externalCandidateId);
  if (existing) return { candidate: await existingCandidate(o.auth, existing.candidateId), created: false, matchedBy: 'ats_record' as const };

  const record = await client.fetchCandidate(o.externalCandidateId).catch((err: unknown) => atsFailure(err, 'candidate'));
  const contact = importedContactSchema.safeParse(record);
  if (!contact.success) {
    throw new HttpError(422, 'That ATS candidate has no usable name or email address, so they cannot be imported. Add them by hand instead.');
  }

  const emailNormalized = normalizeEmail(contact.data.email);
  const linkData = { tenantId, connectionId: connection.id, externalCandidateId: o.externalCandidateId, source: 'import', createdById: o.auth.userId };
  try {
    const outcome = await inApplicationTransaction(async (tx) => {
      const already = await findApplicationOnRole(tx, { tenantId, roleId: o.roleId, emailNormalized });
      if (already) {
        // An application linked to a different record keeps that link: which
        // record it is was decided by an admin or an earlier import.
        const linked = await tx.candidateAtsLink.findUnique({ where: { tenantId_candidateId_connectionId: { tenantId, candidateId: already.id, connectionId: connection.id } } });
        if (!linked) await tx.candidateAtsLink.create({ data: { ...linkData, candidateId: already.id } });
        return { kind: 'exists' as const, candidateId: already.id, linked: !linked };
      }
      const made = await tx.candidate.create({ data: { tenantId, roleId: o.roleId, ...contact.data, emailNormalized } });
      await assignCandidate(made.id, o.auth.userId, 'owner', tx);
      await tx.candidateAtsLink.create({ data: { ...linkData, candidateId: made.id } });
      return { kind: 'created' as const, candidate: made };
    });
    if (outcome.kind === 'exists') {
      // The external id is left out, as for a link set by hand.
      if (outcome.linked) {
        await logAudit({
          tenantId, actorId: o.auth.userId, actorType: 'user', action: 'candidate.ats_link.set',
          entityType: 'Candidate', entityId: outcome.candidateId, after: { connectionId: connection.id, source: 'import' }, requestId: o.requestId,
        });
      }
      return { candidate: await existingCandidate(o.auth, outcome.candidateId), created: false, matchedBy: 'email' as const };
    }
    const { candidate } = outcome;
    await logAudit({
      tenantId, actorId: o.auth.userId, actorType: 'user', action: 'candidate.created',
      entityType: 'Candidate', entityId: candidate.id, after: { source: 'ats' }, requestId: o.requestId,
    });
    await notePipelineEvent({ tenantId, candidateId: candidate.id, roleId: o.roleId, event: 'candidate.onboarded', trigger: 'candidate.created' });
    return { candidate, created: true, matchedBy: null };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent import of the same record won; answer with its candidate.
    const raced = await findLinkByExternalId(tenantId, connection.id, o.externalCandidateId);
    if (!raced) throw err;
    return { candidate: await existingCandidate(o.auth, raced.candidateId), created: false, matchedBy: 'ats_record' as const };
  }
}

function findLinkByExternalId(tenantId: string, connectionId: string, externalCandidateId: string) {
  return prisma.candidateAtsLink.findUnique({
    where: { tenantId_connectionId_externalCandidateId: { tenantId, connectionId, externalCandidateId } },
  });
}

async function existingCandidate(auth: AuthClaims, candidateId: string) {
  return assertCanAccessCandidate(auth, candidateId).catch(outOfScopeAs('This ATS candidate has already been imported. Ask an administrator to give you access to them.'));
}
