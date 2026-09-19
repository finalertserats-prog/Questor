import { prisma } from '../db.js';
import { catalogTitleProblem, normalizeTitle } from '../domain/catalogText.js';
import { logAudit } from './audit.js';
import type { AuthClaims } from './auth.js';
import { findCatalogMatch } from './catalogRoles.js';
import { firstSourceName } from './catalogProposalShape.js';

/**
 * The owner's decisions on proposals. Approval is the only way the refresh
 * reaches the shared catalog, so:
 * - every transition is conditional on the proposal being unchanged since it
 *   was read (status pending AND the same updatedAt): of two operators
 *   clicking at once exactly one wins, and an approval never lands on a
 *   version someone edited meanwhile;
 * - the claim and the catalog write happen in one transaction, so a crash
 *   between them cannot leave an "approved" proposal with nothing created.
 */

export type ReviewFailureCode =
  | 'not_found' | 'not_pending' | 'changed' | 'needs_domain' | 'invalid_domain' | 'family_mismatch' | 'invalid_title' | 'target_inactive' | 'superseded';

export type ReviewResult =
  | { readonly ok: true; readonly status: 'approved' | 'rejected'; readonly createdRoleId?: string }
  | { readonly ok: false; readonly httpStatus: 400 | 404 | 409; readonly code: ReviewFailureCode; readonly error: string; readonly existing?: { readonly id: string; readonly title: string } };

type Proposal = NonNullable<Awaited<ReturnType<typeof prisma.catalogProposal.findUnique>>>;
type Existing = { readonly id: string; readonly title: string };

function fail(httpStatus: 400 | 404 | 409, code: ReviewFailureCode, error: string, existing?: Existing): ReviewResult {
  return { ok: false, httpStatus, code, error, ...(existing ? { existing } : {}) };
}

const NOT_PENDING = () => fail(409, 'not_pending', 'This proposal has already been reviewed.');
const CHANGED = () => fail(409, 'changed', 'This proposal changed while you were deciding. Review it again.');

/** Families are global; one belongs to a domain when an active role there uses it. */
export async function familyBelongsToDomain(domainId: string, familyId: string): Promise<boolean> {
  const used = await prisma.catalogRole.findFirst({ where: { domainId, familyId, status: 'active' }, select: { id: true } });
  return used !== null;
}

function decided(status: 'approved' | 'rejected' | 'superseded', reviewer: AuthClaims, note: string) {
  return { status, reviewedById: reviewer.userId, reviewedAt: new Date(), reviewerNote: note };
}

/** Why a claim matched nothing: decided by someone else, or edited since it was read. */
async function lostClaim(id: string): Promise<ReviewResult> {
  const now = await prisma.catalogProposal.findUnique({ where: { id }, select: { status: true } });
  return now?.status === 'pending' ? CHANGED() : NOT_PENDING();
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { readonly code?: string }).code === 'P2002';
}

/** SQLite busy / Postgres serialization: the other transaction won the race. */
function isWriteConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && ['P2034', 'P1008'].includes((err as { readonly code?: string }).code ?? '');
}

async function audit(reviewer: AuthClaims, action: string, proposal: Proposal, after: object): Promise<void> {
  // logAudit never throws: a failed audit write must not undo a decision already made.
  await logAudit({ tenantId: reviewer.tenantId, actorId: reviewer.userId, actorType: 'user', action, entityType: 'CatalogProposal', entityId: proposal.id, after: { kind: proposal.kind, title: proposal.title, ...after } });
}

async function supersede(proposal: Proposal, reviewer: AuthClaims, note: string, existing: Existing): Promise<ReviewResult> {
  const moved = await prisma.catalogProposal.updateMany({ where: { id: proposal.id, status: 'pending', updatedAt: proposal.updatedAt }, data: decided('superseded', reviewer, note) });
  if (moved.count !== 1) return lostClaim(proposal.id);
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

/**
 * Claim and write in one transaction. Returns the created id, null when the
 * claim matched nothing, or 'duplicate' when the catalog already had the title.
 */
async function claimAndCreate(proposal: Proposal, reviewer: AuthClaims, note: string, create: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<string>): Promise<string | null | 'duplicate'> {
  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.catalogProposal.updateMany({ where: { id: proposal.id, status: 'pending', updatedAt: proposal.updatedAt }, data: decided('approved', reviewer, note) });
      if (claimed.count !== 1) return null;
      return create(tx);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return 'duplicate';
    if (isWriteConflict(err)) return null;
    throw err;
  }
}

async function approveRole(proposal: Proposal, reviewer: AuthClaims, note: string): Promise<ReviewResult> {
  const problem = await roleProblem(proposal);
  if (problem) return problem;
  const domainId = proposal.domainId as string;
  const existing = await findCatalogMatch(domainId, proposal.title);
  if (existing) return supersede(proposal, reviewer, note, { id: existing.id, title: existing.title });
  const title = proposal.title.trim();
  const created = await claimAndCreate(proposal, reviewer, note, async (tx) => {
    const role = await tx.catalogRole.create({
      // The platform's, not the approver's organisation's: no owning tenant.
      data: { domainId, familyId: proposal.familyId, title, normalizedTitle: normalizeTitle(title), summary: proposal.summary, techStackJson: '[]', source: 'automation', status: 'active', createdById: reviewer.userId },
      select: { id: true },
    });
    await tx.catalogProposal.update({ where: { id: proposal.id }, data: { createdCatalogRoleId: role.id } });
    return role.id;
  });
  if (created === null) return lostClaim(proposal.id);
  if (created === 'duplicate') {
    // Another organisation added the title between our check and our insert.
    const winner = await findCatalogMatch(domainId, title);
    return winner ? supersede(proposal, reviewer, note, { id: winner.id, title: winner.title }) : lostClaim(proposal.id);
  }
  await logAudit({ tenantId: reviewer.tenantId, actorId: reviewer.userId, actorType: 'user', action: 'catalog.role.created', entityType: 'CatalogRole', entityId: created, after: { title, domainId, source: 'automation' } });
  await audit(reviewer, 'catalog.proposal.approved', proposal, { createdRoleId: created });
  return { ok: true, status: 'approved', createdRoleId: created };
}

async function approveAlias(proposal: Proposal, reviewer: AuthClaims, note: string): Promise<ReviewResult> {
  const role = proposal.targetRoleId ? await prisma.catalogRole.findUnique({ where: { id: proposal.targetRoleId }, select: { id: true, title: true, normalizedTitle: true, status: true } }) : null;
  if (!role || role.status !== 'active') return fail(400, 'target_inactive', 'The role this title was proposed for is no longer active.');
  const problem = catalogTitleProblem(proposal.title);
  if (problem) return fail(400, 'invalid_title', problem);
  const normalizedAlias = normalizeTitle(proposal.title);
  const target = { id: role.id, title: role.title };
  const clash = normalizedAlias === role.normalizedTitle
    || (await prisma.catalogRoleAlias.findFirst({ where: { roleId: role.id, normalizedAlias }, select: { id: true } })) !== null;
  if (clash) return supersede(proposal, reviewer, note, target);
  const created = await claimAndCreate(proposal, reviewer, note, async (tx) => {
    const alias = await tx.catalogRoleAlias.create({ data: { roleId: role.id, alias: proposal.title.trim(), normalizedAlias, source: firstSourceName(proposal.id, proposal.sourcesJson), status: 'active' }, select: { id: true } });
    return alias.id;
  });
  if (created === null) return lostClaim(proposal.id);
  if (created === 'duplicate') return supersede(proposal, reviewer, note, target);
  await audit(reviewer, 'catalog.proposal.approved', proposal, { roleId: role.id });
  return { ok: true, status: 'approved' };
}

/**
 * `expectedUpdatedAt`, when the client sends it, is the version the operator
 * was looking at: approving anything newer is refused as changed.
 */
export async function approveProposal(id: string, reviewer: AuthClaims, note: string, expectedUpdatedAt?: Date): Promise<ReviewResult> {
  const proposal = await prisma.catalogProposal.findUnique({ where: { id } });
  if (!proposal) return fail(404, 'not_found', 'Proposal not found.');
  if (proposal.status !== 'pending') return NOT_PENDING();
  if (expectedUpdatedAt && expectedUpdatedAt.getTime() !== proposal.updatedAt.getTime()) return CHANGED();
  return proposal.kind === 'new_alias' ? approveAlias(proposal, reviewer, note) : approveRole(proposal, reviewer, note);
}

export async function rejectProposal(id: string, reviewer: AuthClaims, note: string): Promise<ReviewResult> {
  const proposal = await prisma.catalogProposal.findUnique({ where: { id } });
  if (!proposal) return fail(404, 'not_found', 'Proposal not found.');
  const moved = await prisma.catalogProposal.updateMany({ where: { id, status: 'pending' }, data: decided('rejected', reviewer, note) });
  if (moved.count !== 1) return NOT_PENDING();
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
