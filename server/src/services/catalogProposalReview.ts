import { prisma } from '../db.js';
import { catalogTitleProblem, normalizeTitle } from '../domain/catalogText.js';
import { logAudit } from './audit.js';
import type { AuthClaims } from './auth.js';
import { addCatalogRole, findCatalogMatch } from './catalogRoles.js';
import { firstSourceName } from './catalogProposalShape.js';

/**
 * The owner's decisions on proposals. Approval is the only way the refresh
 * reaches the shared catalog, so every transition is conditional on the
 * proposal still being pending: of two operators clicking at once, exactly
 * one wins, and the catalog gets one row.
 */

export type ReviewFailureCode =
  | 'not_found' | 'not_pending' | 'needs_domain' | 'invalid_domain' | 'family_mismatch' | 'invalid_title' | 'target_inactive' | 'superseded';

export type ReviewResult =
  | { readonly ok: true; readonly status: 'approved' | 'rejected'; readonly createdRoleId?: string }
  | { readonly ok: false; readonly httpStatus: 400 | 404 | 409; readonly code: ReviewFailureCode; readonly error: string; readonly existing?: { readonly id: string; readonly title: string } };

type Proposal = NonNullable<Awaited<ReturnType<typeof prisma.catalogProposal.findUnique>>>;

function fail(httpStatus: 400 | 404 | 409, code: ReviewFailureCode, error: string, existing?: { id: string; title: string }): ReviewResult {
  return { ok: false, httpStatus, code, error, ...(existing ? { existing } : {}) };
}

const NOT_PENDING = () => fail(409, 'not_pending', 'This proposal has already been reviewed.');

/** Families are global; one belongs to a domain when an active role there uses it. */
export async function familyBelongsToDomain(domainId: string, familyId: string): Promise<boolean> {
  const used = await prisma.catalogRole.findFirst({ where: { domainId, familyId, status: 'active' }, select: { id: true } });
  return used !== null;
}

async function transition(id: string, status: 'approved' | 'rejected' | 'superseded', reviewer: AuthClaims, note: string): Promise<boolean> {
  const moved = await prisma.catalogProposal.updateMany({ where: { id, status: 'pending' }, data: { status, reviewedById: reviewer.userId, reviewedAt: new Date(), reviewerNote: note } });
  return moved.count === 1;
}

/** Undo our own claim when the catalog write failed, so the proposal can be tried again. */
async function releaseClaim(id: string): Promise<void> {
  await prisma.catalogProposal.updateMany({ where: { id, status: 'approved', createdCatalogRoleId: null }, data: { status: 'pending', reviewedById: null, reviewedAt: null, reviewerNote: '' } });
}

async function audit(reviewer: AuthClaims, action: string, proposal: Proposal, after: object): Promise<void> {
  await logAudit({ tenantId: reviewer.tenantId, actorId: reviewer.userId, actorType: 'user', action, entityType: 'CatalogProposal', entityId: proposal.id, after: { kind: proposal.kind, title: proposal.title, ...after } });
}

async function supersede(proposal: Proposal, reviewer: AuthClaims, note: string, existing: { id: string; title: string }): Promise<ReviewResult> {
  if (!(await transition(proposal.id, 'superseded', reviewer, note))) return NOT_PENDING();
  await audit(reviewer, 'catalog.proposal.superseded', proposal, { existingRoleId: existing.id });
  return fail(409, 'superseded', `"${existing.title}" is already in the catalog.`, existing);
}

async function roleProblem(proposal: Proposal): Promise<ReviewResult | null> {
  if (!proposal.domainId) return fail(400, 'needs_domain', 'Choose a domain before approving');
  const domain = await prisma.catalogDomain.findFirst({ where: { id: proposal.domainId, status: 'active' }, select: { id: true } });
  if (!domain) return fail(400, 'invalid_domain', 'That domain is no longer active. Choose another.');
  if (proposal.familyId && !(await familyBelongsToDomain(proposal.domainId, proposal.familyId))) return fail(400, 'family_mismatch', 'That job family is not used in this domain. Choose another or clear it.');
  const problem = catalogTitleProblem(proposal.title);
  return problem ? fail(400, 'invalid_title', problem) : null;
}

async function approveRole(proposal: Proposal, reviewer: AuthClaims, note: string): Promise<ReviewResult> {
  const problem = await roleProblem(proposal);
  if (problem) return problem;
  const domainId = proposal.domainId as string;
  const existing = await findCatalogMatch(domainId, proposal.title);
  if (existing) return supersede(proposal, reviewer, note, { id: existing.id, title: existing.title });
  if (!(await transition(proposal.id, 'approved', reviewer, note))) return NOT_PENDING();
  let result: Awaited<ReturnType<typeof addCatalogRole>>;
  try {
    result = await addCatalogRole({ auth: reviewer, domainId, title: proposal.title, familyId: proposal.familyId ?? undefined, source: 'automation', summary: proposal.summary });
  } catch (err) {
    await releaseClaim(proposal.id);
    throw err;
  }
  if (result.kind === 'existing') {
    // Another organisation added the title between our check and our insert.
    await prisma.catalogProposal.update({ where: { id: proposal.id }, data: { status: 'superseded' } });
    await audit(reviewer, 'catalog.proposal.superseded', proposal, { existingRoleId: result.role.id });
    return fail(409, 'superseded', `"${result.role.title}" is already in the catalog.`, { id: result.role.id, title: result.role.title });
  }
  await prisma.catalogProposal.update({ where: { id: proposal.id }, data: { createdCatalogRoleId: result.id } });
  await audit(reviewer, 'catalog.proposal.approved', proposal, { createdRoleId: result.id });
  return { ok: true, status: 'approved', createdRoleId: result.id };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { readonly code?: string }).code === 'P2002';
}

async function approveAlias(proposal: Proposal, reviewer: AuthClaims, note: string): Promise<ReviewResult> {
  const role = proposal.targetRoleId ? await prisma.catalogRole.findUnique({ where: { id: proposal.targetRoleId }, select: { id: true, title: true, normalizedTitle: true, status: true } }) : null;
  if (!role || role.status !== 'active') return fail(400, 'target_inactive', 'The role this title was proposed for is no longer active.');
  const problem = catalogTitleProblem(proposal.title);
  if (problem) return fail(400, 'invalid_title', problem);
  const normalizedAlias = normalizeTitle(proposal.title);
  const clash = normalizedAlias === role.normalizedTitle
    || (await prisma.catalogRoleAlias.findFirst({ where: { roleId: role.id, normalizedAlias }, select: { id: true } })) !== null;
  if (clash) return supersede(proposal, reviewer, note, { id: role.id, title: role.title });
  if (!(await transition(proposal.id, 'approved', reviewer, note))) return NOT_PENDING();
  try {
    await prisma.catalogRoleAlias.create({ data: { roleId: role.id, alias: proposal.title.trim(), normalizedAlias, source: firstSourceName(proposal.id, proposal.sourcesJson), status: 'active' } });
  } catch (err) {
    if (!isUniqueViolation(err)) {
      await releaseClaim(proposal.id);
      throw err;
    }
    await prisma.catalogProposal.update({ where: { id: proposal.id }, data: { status: 'superseded' } });
    await audit(reviewer, 'catalog.proposal.superseded', proposal, { existingRoleId: role.id });
    return fail(409, 'superseded', `"${role.title}" already has this title.`, { id: role.id, title: role.title });
  }
  await audit(reviewer, 'catalog.proposal.approved', proposal, { roleId: role.id });
  return { ok: true, status: 'approved' };
}

export async function approveProposal(id: string, reviewer: AuthClaims, note: string): Promise<ReviewResult> {
  const proposal = await prisma.catalogProposal.findUnique({ where: { id } });
  if (!proposal) return fail(404, 'not_found', 'Proposal not found.');
  if (proposal.status !== 'pending') return NOT_PENDING();
  return proposal.kind === 'new_alias' ? approveAlias(proposal, reviewer, note) : approveRole(proposal, reviewer, note);
}

export async function rejectProposal(id: string, reviewer: AuthClaims, note: string): Promise<ReviewResult> {
  const proposal = await prisma.catalogProposal.findUnique({ where: { id } });
  if (!proposal) return fail(404, 'not_found', 'Proposal not found.');
  if (!(await transition(id, 'rejected', reviewer, note))) return NOT_PENDING();
  await audit(reviewer, 'catalog.proposal.rejected', proposal, { note });
  return { ok: true, status: 'rejected' };
}

export const BULK_REVIEW_MAX = 100;

/** One decision per id, in order; a failure on one item never stops the rest. */
export async function bulkReview(ids: readonly string[], action: 'approve' | 'reject', reviewer: AuthClaims, note: string) {
  const results: Array<{ id: string } & ReviewResult> = [];
  for (const id of ids) {
    const result = action === 'approve' ? await approveProposal(id, reviewer, note) : await rejectProposal(id, reviewer, note);
    results.push({ id, ...result });
  }
  return results;
}
