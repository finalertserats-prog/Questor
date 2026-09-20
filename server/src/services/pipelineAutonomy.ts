import type { CandidatePipeline } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { logAudit } from './audit.js';
import { DEFAULT_STAGES, parseStages, parseStagesStrict } from '../domain/pipelineStages.js';
import { resolveTransition, type PipelineEvent, type StageTransition } from '../domain/pipelineAutonomy.js';

/**
 * Applies the autonomous journey (domain/pipelineAutonomy.ts) to the database.
 *
 * Called from the places where the events actually happen — candidate
 * creation, resume analysis, interview creation and scheduling, assessment —
 * never from a timer. The primary write has already committed by then, so a
 * failure here is logged and never turns a created interview into a 500.
 */

export interface PipelineEventInput {
  readonly tenantId: string;
  readonly candidateId: string;
  /** The candidate's role; a candidate without one has no pipeline to move. */
  readonly roleId: string | null;
  readonly event: PipelineEvent;
  /** The audit action of the write that caused this, so the trail reads end to end. */
  readonly trigger: string;
}

const RETRIES = 3;

/**
 * The candidate's pipeline for this role, started at the first stage if they
 * have none yet. Two events arriving together for a candidate without a
 * pipeline both try to create it; the unique (candidate, role) key lets exactly
 * one succeed and the other reads what it created.
 */
async function ensurePipeline(o: PipelineEventInput & { readonly roleId: string }): Promise<CandidatePipeline> {
  const where = { tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId };
  const existing = await prisma.candidatePipeline.findFirst({ where });
  if (existing) return existing;

  const role = await prisma.role.findFirst({ where: { id: o.roleId, tenantId: o.tenantId }, select: { pipelineStagesJson: true } });
  const stages = role?.pipelineStagesJson ? parseStages(role.pipelineStagesJson) : DEFAULT_STAGES.map((s) => ({ ...s }));
  try {
    const created = await prisma.candidatePipeline.create({
      data: { ...where, stagesJson: JSON.stringify(stages), currentStageKey: stages[0].key },
    });
    await logAudit({
      tenantId: o.tenantId, actorType: 'system', action: 'pipeline.created', entityType: 'CandidatePipeline', entityId: created.id,
      after: { candidateId: o.candidateId, roleId: o.roleId, stages: stages.map((s) => s.key), trigger: o.trigger },
    });
    return created;
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err;
    return prisma.candidatePipeline.findFirstOrThrow({ where });
  }
}

/**
 * Move the candidate forward if this event calls for it. Returns the move
 * made, or null when the event changed nothing (already there, or beyond).
 *
 * The update is conditional on the stage that was read, so two events landing
 * together cannot both apply: the loser re-reads and resolves again from the
 * stage the winner left, which is how a Silver and a Gold event arriving at
 * once still end at Gold whichever commits first.
 */
export async function applyPipelineEvent(o: PipelineEventInput): Promise<StageTransition | null> {
  if (!o.roleId) return null;
  let pipeline = await ensurePipeline({ ...o, roleId: o.roleId });
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (pipeline.status !== 'ACTIVE') return null;
    const stages = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' });
    const transition = resolveTransition(stages, pipeline.currentStageKey, o.event);
    if (!transition) return null;

    const moved = await prisma.candidatePipeline.updateMany({
      where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: transition.from },
      data: { currentStageKey: transition.to },
    });
    if (moved.count === 1) {
      await logAudit({
        tenantId: o.tenantId, actorType: 'system', action: 'pipeline.auto_advanced', entityType: 'CandidatePipeline', entityId: pipeline.id,
        before: { stage: transition.from }, after: { stage: transition.to, event: o.event, trigger: o.trigger },
      });
      return transition;
    }
    pipeline = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } });
  }
  logger.warn({ candidateId: o.candidateId, event: o.event }, 'Pipeline kept changing while an event was applied; giving up this event');
  return null;
}

/**
 * The same, for callers whose own write must not fail because of the
 * pipeline. Logged loudly: a candidate silently left at the wrong stage is
 * exactly what the autonomous journey exists to prevent.
 */
export async function notePipelineEvent(o: PipelineEventInput): Promise<void> {
  try {
    await applyPipelineEvent(o);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), candidateId: o.candidateId, event: o.event }, 'Pipeline event could not be applied');
  }
}
