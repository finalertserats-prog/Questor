import { prisma, parseJsonStrict } from '../db.js';
import { HttpError } from '../middleware/index.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import { roleSuccessProfileSchema } from '../domain/profileSchema.js';

export type ScorecardRow = { readonly id: string; readonly version: number; readonly status: string; readonly profileJson: string; readonly approvedAt: Date | null };

/** The role's newest scorecard version, whatever its status. */
export async function latestScorecard(roleId: string): Promise<ScorecardRow> {
  const latest = await prisma.roleScorecardVersion.findFirst({ where: { roleId }, orderBy: { version: 'desc' } });
  if (!latest) throw new HttpError(404, 'No scorecard to update');
  return latest;
}

export function profileOf(scorecard: ScorecardRow): RoleSuccessProfile {
  return parseJsonStrict<RoleSuccessProfile>(scorecard.profileJson, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' });
}

/**
 * Store an edited profile: onto the current draft, or as a new draft version
 * when the current one is approved. An approved version is never rewritten,
 * because interviews already bound to it (InterviewSession.scorecardId) were
 * planned and will be scored against exactly what it says.
 */
export async function writeScorecardProfile(roleId: string, latest: ScorecardRow, profile: RoleSuccessProfile): Promise<ScorecardRow> {
  // Every write path, whole-profile or one competency at a time, meets the
  // same bounds; an edit that computed an invalid scorecard is refused here
  // rather than stored and discovered at approval.
  const valid = roleSuccessProfileSchema.safeParse(profile);
  if (!valid.success) {
    throw new HttpError(400, valid.error.issues[0]?.message ?? 'The scorecard is not valid.', 'scorecard_invalid');
  }
  const profileJson = JSON.stringify(valid.data);
  if (latest.status === 'approved') {
    return prisma.roleScorecardVersion.create({ data: { roleId, version: latest.version + 1, status: 'draft', profileJson } });
  }
  return prisma.roleScorecardVersion.update({ where: { id: latest.id }, data: { profileJson } });
}
