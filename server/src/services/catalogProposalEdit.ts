import { prisma } from '../db.js';
import { catalogTitleProblem, normalizeTitle } from '../domain/catalogText.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import type { AuthClaims } from './auth.js';
import { familyBelongsToDomain } from './catalogProposalReview.js';
import { PROPOSAL_INCLUDE, shapeProposal, type ShapedProposal } from './catalogProposalShape.js';

/**
 * The owner correcting a proposal before deciding: a better title, the right
 * domain or family, a clearer summary, or (for an alternative title) the right
 * role. Only while pending, and every id is checked against the live catalog.
 */

export interface ProposalEdit {
  readonly title?: string;
  readonly domainId?: string | null;
  readonly familyId?: string | null;
  readonly summary?: string;
  readonly targetRoleId?: string | null;
}

type Proposal = NonNullable<Awaited<ReturnType<typeof prisma.catalogProposal.findUnique>>>;

async function checkDomain(domainId: string): Promise<void> {
  const domain = await prisma.catalogDomain.findFirst({ where: { id: domainId, status: 'active' }, select: { id: true } });
  if (!domain) throw new HttpError(400, 'Unknown or inactive catalog domain.');
}

/** The family after the edit: an explicit choice is checked; a kept one is cleared if it no longer fits. */
async function resolveFamily(edit: ProposalEdit, domainId: string | null, current: string | null): Promise<string | null> {
  if (edit.familyId === null) return null;
  if (edit.familyId !== undefined) {
    if (!domainId) throw new HttpError(400, 'Choose a domain before a job family.');
    const family = await prisma.catalogJobFamily.findUnique({ where: { id: edit.familyId }, select: { id: true } });
    if (!family) throw new HttpError(400, 'Unknown job family.');
    if (!(await familyBelongsToDomain(domainId, edit.familyId))) throw new HttpError(400, 'That job family is not used in this domain.');
    return edit.familyId;
  }
  if (!current || !domainId) return null;
  return (await familyBelongsToDomain(domainId, current)) ? current : null;
}

async function roleFields(row: Proposal, edit: ProposalEdit) {
  if (edit.targetRoleId !== undefined) throw new HttpError(400, 'Only an alternative title points at a role.');
  if (edit.domainId) await checkDomain(edit.domainId);
  const domainId = edit.domainId !== undefined ? edit.domainId : row.domainId;
  return { domainId, familyId: await resolveFamily(edit, domainId, row.familyId) };
}

async function aliasFields(row: Proposal, edit: ProposalEdit) {
  if (edit.domainId !== undefined || edit.familyId !== undefined) throw new HttpError(400, 'An alternative title takes the domain of its role; choose the role instead.');
  if (edit.targetRoleId === undefined) return {};
  if (edit.targetRoleId === null) throw new HttpError(400, 'An alternative title needs a role.');
  const role = await prisma.catalogRole.findFirst({ where: { id: edit.targetRoleId, status: 'active' }, select: { id: true, domainId: true } });
  if (!role) throw new HttpError(400, 'Unknown or inactive catalog role.');
  return { targetRoleId: role.id, domainId: role.domainId };
}

export async function editProposal(id: string, edit: ProposalEdit, reviewer: AuthClaims): Promise<ShapedProposal> {
  const row = await prisma.catalogProposal.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'Proposal not found.');
  if (row.status !== 'pending') throw new HttpError(409, 'Only a pending proposal can be edited.', 'not_pending');
  const title = edit.title?.trim() ?? row.title;
  const problem = catalogTitleProblem(title);
  if (problem) throw new HttpError(400, problem);
  const fields = row.kind === 'new_alias' ? await aliasFields(row, edit) : await roleFields(row, edit);
  const data = { ...fields, title, normalizedTitle: normalizeTitle(title), ...(edit.summary !== undefined ? { summary: edit.summary.trim() } : {}) };
  // Conditional on the version read: an edit racing an approval (or another
  // edit) must not rewrite a decided proposal or silently undo the other edit.
  const updated = await prisma.catalogProposal.updateMany({ where: { id, status: 'pending', updatedAt: row.updatedAt }, data });
  if (updated.count !== 1) {
    const now = await prisma.catalogProposal.findUnique({ where: { id }, select: { status: true } });
    if (now?.status === 'pending') throw new HttpError(409, 'This proposal changed while you were editing. Reload it and try again.', 'changed');
    throw new HttpError(409, 'Only a pending proposal can be edited.', 'not_pending');
  }
  await logAudit({
    tenantId: reviewer.tenantId, actorId: reviewer.userId, actorType: 'user', action: 'catalog.proposal.edited', entityType: 'CatalogProposal', entityId: id,
    before: { title: row.title, domainId: row.domainId, familyId: row.familyId, targetRoleId: row.targetRoleId }, after: data,
  });
  return shapeProposal(await prisma.catalogProposal.findUniqueOrThrow({ where: { id }, include: PROPOSAL_INCLUDE }));
}
