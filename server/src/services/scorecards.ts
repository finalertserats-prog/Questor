import { prisma } from '../db.js';

/**
 * The scorecard a resume should be scored against.
 *
 * The approved version, when there is one; otherwise the newest draft, so a
 * role that has never been approved still gets an indicative fit. This used to
 * be one query ordered by `status desc`, with a comment saying "approved
 * preferred". Descending string order puts "draft" before "approved", so every
 * role mid-edit scored resumes against its unapproved draft while the interview
 * plan used the approved one: two numbers for the same candidate, silently
 * disagreeing.
 */
export async function scorecardForFit(roleId: string | null | undefined) {
  if (!roleId) return null;
  const approved = await prisma.roleScorecardVersion.findFirst({
    where: { roleId, status: 'approved' },
    orderBy: { version: 'desc' },
  });
  if (approved) return approved;
  return prisma.roleScorecardVersion.findFirst({ where: { roleId }, orderBy: { version: 'desc' } });
}
