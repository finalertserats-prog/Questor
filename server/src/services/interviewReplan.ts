import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import { attachLibrary } from '../library/planning.js';
import { roleTechStack } from './roleTechStack.js';
import type { FitScore, InterviewPlan, RoleSuccessProfile } from '../domain/types.js';
import { logAudit } from './audit.js';
import { lockSession } from './sessionLock.js';

/**
 * An interview that has not started yet follows the role's CURRENT approved
 * scorecard, not the one it was created under.
 *
 * HR edits competencies and a manager approves the new version; the sessions
 * already invited were planned from the old one. Once a candidate has answered
 * anything, that plan is the record of what they were asked and stays. Before
 * that, the plan is only a promise, and it is rebuilt here from the newest
 * approved scorecard the moment the interview begins.
 */

export type ReplanReason = 'replanned' | 'same_scorecard' | 'has_answers' | 'no_approved_scorecard';

export interface ReplanOutcome {
  readonly replanned: boolean;
  readonly reason: ReplanReason;
}

/** Whether a session in this position would be re-planned at start. */
export function needsReplan(session: { readonly scorecardId: string; readonly candidateTurns: number }, latestApprovedId: string | null): boolean {
  return session.candidateTurns === 0 && latestApprovedId !== null && latestApprovedId !== session.scorecardId;
}

async function latestApproved(roleId: string) {
  return prisma.roleScorecardVersion.findFirst({ where: { roleId, status: 'approved' }, orderBy: { version: 'desc' } });
}

/** For the HR detail page: the plan on show will be rebuilt when the interview starts. */
export async function replanPending(session: { readonly id: string; readonly roleId: string; readonly scorecardId: string }): Promise<boolean> {
  const [candidateTurns, latest] = await Promise.all([
    prisma.turn.count({ where: { sessionId: session.id, speaker: 'candidate' } }),
    latestApproved(session.roleId),
  ]);
  return needsReplan({ scorecardId: session.scorecardId, candidateTurns }, latest?.id ?? null);
}

class AlreadyReplanned extends Error {}

/**
 * Rebuild the session's plan from the latest approved scorecard, if it is
 * newer and nothing has been answered. Safe to call from every start: the
 * scorecard swap is conditional on the version we read, so two starts that
 * both reach this point write one plan, and a later start finds the ids equal
 * and does nothing.
 */
export async function replanFromLatestScorecard(sessionId: string): Promise<ReplanOutcome> {
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, include: { plan: true } });
  if (!session || !session.plan) return { replanned: false, reason: 'no_approved_scorecard' };
  const candidateTurns = await prisma.turn.count({ where: { sessionId, speaker: 'candidate' } });
  if (candidateTurns > 0) return { replanned: false, reason: 'has_answers' };
  const latest = await latestApproved(session.roleId);
  if (!latest) return { replanned: false, reason: 'no_approved_scorecard' };
  if (!needsReplan({ scorecardId: session.scorecardId, candidateTurns }, latest.id)) return { replanned: false, reason: 'same_scorecard' };

  const profile = parseJsonStrict<RoleSuccessProfile>(latest.profileJson, { model: 'RoleScorecardVersion', id: latest.id, field: 'profileJson' });
  // Duration, language, modules and the candidate's band were decided when the
  // interview was set up and are not what changed; only the competencies are.
  const previous = parseJsonOptional<Partial<InterviewPlan>>(session.plan.planJson, {}, { model: 'InterviewPlanVersion', id: session.plan.id, field: 'planJson' });
  const latestProfile = await prisma.candidateProfileVersion.findFirst({ where: { candidateId: session.candidateId }, orderBy: { version: 'desc' } });
  const fit = latestProfile ? parseJsonStrict<FitScore>(latestProfile.fitScoreJson, { model: 'CandidateProfileVersion', id: latestProfile.id, field: 'fitScoreJson' }) : undefined;
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { id: session.roleId }, select: { id: true, techStackJson: true } });
  const plan = await attachLibrary(buildInterviewPlan({
    role: profile, fit, durationMinutes: session.durationMinutes, language: session.language,
    modules: previous.modules ?? [], band: previous.band, bandRationale: previous.bandRationale,
    techStack: roleTechStack(roleRow),
    // The CV has not changed either: keep the CV-anchored questions (identity L3).
    cvAnchors: previous.blocks?.find((b) => b.competencyId === '__resume_validation__')?.cvAnchors,
  }), {
    tenantId: session.tenantId, roleId: session.roleId, candidateId: session.candidateId, scorecardId: latest.id,
    competencies: profile.competencies, fit, replanningSessionId: sessionId,
  });
  const nextVersion = session.plan.version + 1;

  try {
    await prisma.$transaction(async (tx) => {
      // The swap is the lock: whichever caller moves the scorecard pointer
      // writes the plan, and the other sees count 0 and leaves both alone.
      // The same lock every turn append takes, so the count below and the
      // swap after it cannot interleave with an answer being committed: an
      // answer that landed since the count above makes this plan the record
      // of what was asked, so it stays.
      await lockSession(tx, sessionId);
      if (await tx.turn.count({ where: { sessionId, speaker: 'candidate' } }) > 0) throw new AlreadyReplanned();
      const claimed = await tx.interviewSession.updateMany({
        where: { id: sessionId, scorecardId: session.scorecardId },
        data: { scorecardId: latest.id },
      });
      if (claimed.count === 0) throw new AlreadyReplanned();
      await tx.interviewPlanVersion.update({ where: { sessionId }, data: { version: nextVersion, planJson: JSON.stringify(plan) } });
    });
  } catch (err) {
    if (err instanceof AlreadyReplanned) return { replanned: false, reason: 'same_scorecard' };
    throw err;
  }

  await logAudit({
    tenantId: session.tenantId, actorType: 'system', action: 'interview.replanned', entityType: 'InterviewSession', entityId: sessionId,
    before: { scorecardId: session.scorecardId, planVersion: session.plan.version },
    after: { scorecardId: latest.id, scorecardVersion: latest.version, planVersion: nextVersion, competencies: plan.blocks.filter((b) => !b.competencyId.startsWith('__')).map((b) => b.competencyId) },
  });
  return { replanned: true, reason: 'replanned' };
}
