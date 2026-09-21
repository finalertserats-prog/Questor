import type { CandidatePipeline } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { logAudit } from './audit.js';
import { DEFAULT_STAGES, parseStages, parseStagesStrict, type StageKind } from '../domain/pipelineStages.js';
import {
  decisionOfDisposition, resolveDecision, resolveTransition,
  type DecisionEffect, type DecisionOutcome, type PipelineEvent, type StageTransition,
} from '../domain/pipelineAutonomy.js';

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
async function ensurePipeline(o: { readonly tenantId: string; readonly candidateId: string; readonly roleId: string; readonly trigger: string }): Promise<CandidatePipeline> {
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

// ---------------------------------------------------------------------------
// Decisions (domain/pipelineAutonomy.ts, resolveDecision)
// ---------------------------------------------------------------------------

export type DecisionSource = 'review' | 'pipeline';

export interface PipelineDecisionInput {
  readonly tenantId: string;
  readonly outcome: DecisionOutcome;
  /** Kept on the pipeline, which erasure removes; the audit records only that one was given. */
  readonly reason: string;
  /**
   * The stage the decision is about. The pipeline panel names the key; the
   * assessment review knows it judged the AI interview, not which key this
   * role's plan gave that stage, so it names the kind.
   */
  readonly about: { readonly stageKey: string } | { readonly stageKind: StageKind };
  readonly source: DecisionSource;
  /** The person whose decision this is. The system only carries it out. */
  readonly actorId: string;
  readonly trigger: string;
}

export type DecisionResult =
  | { readonly applied: true; readonly effect: DecisionEffect }
  | { readonly applied: false; readonly because: 'already_decided' | 'nothing_to_do' | 'contended' };

async function auditDecision(pipeline: CandidatePipeline, o: PipelineDecisionInput, effect: DecisionEffect, about: string): Promise<void> {
  const actor = { tenantId: o.tenantId, actorType: 'user' as const, actorId: o.actorId, entityType: 'CandidatePipeline', entityId: pipeline.id };
  if (effect.kind === 'close') {
    await logAudit({
      ...actor, action: 'pipeline.decided',
      after: { decision: effect.outcome, stage: effect.atStageKey, about, source: o.source, trigger: o.trigger, reasonRecorded: true },
    });
    return;
  }
  // Reaching the last stage is a finalisation whoever's button it was, so the
  // trail reads the same as the Finalise endpoint's.
  await logAudit({
    ...actor, action: effect.final ? 'pipeline.finalized' : 'pipeline.advanced',
    before: { stage: effect.from }, after: { stage: effect.to, decision: o.outcome, source: o.source, trigger: o.trigger },
  });
}

/**
 * Apply a person's decision to a pipeline already loaded (and scoped) by the
 * caller. Same conditional-update discipline as the events: the write only
 * lands on the stage and status that were read, so a decision racing an
 * autonomous move, a manual advance, a Finalise or another decision either
 * re-resolves from the winner's state or reports the contention — it never
 * closes a pipeline at a stage the candidate had already left.
 */
export async function decidePipeline(loaded: CandidatePipeline, o: PipelineDecisionInput): Promise<DecisionResult> {
  let pipeline = loaded;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (pipeline.status !== 'ACTIVE') return { applied: false, because: 'already_decided' };
    const wanted = o.about;
    // A decision named by stage key is about the stage the person was looking
    // at. If a Finalise or an autonomous move has carried the candidate past
    // it since, that decision is stale — it must not close them at a stage
    // nobody judged. A verdict named by kind (the review of the AI round)
    // stands wherever the candidate has got to.
    if ('stageKey' in wanted && pipeline.currentStageKey !== wanted.stageKey) return { applied: false, because: 'contended' };
    const stages = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' });
    const about = 'stageKey' in wanted ? wanted.stageKey : stages.find((s) => s.kind === wanted.stageKind)?.key;
    const effect = about ? resolveDecision(stages, pipeline.currentStageKey, o.outcome, about) : null;
    if (!effect || !about) return { applied: false, because: 'nothing_to_do' };

    const written = effect.kind === 'advance'
      ? await prisma.candidatePipeline.updateMany({
        where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: effect.from },
        data: { currentStageKey: effect.to },
      })
      : await prisma.candidatePipeline.updateMany({
        where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: effect.atStageKey },
        data: {
          status: 'DECIDED', decision: effect.outcome, decisionReason: o.reason,
          decidedAtStageKey: effect.atStageKey, decidedById: o.actorId, decidedAt: new Date(),
        },
      });
    if (written.count === 1) {
      await auditDecision(pipeline, o, effect, about);
      return { applied: true, effect };
    }
    pipeline = await prisma.candidatePipeline.findUniqueOrThrow({ where: { id: pipeline.id } });
  }
  logger.warn({ pipelineId: pipeline.id, outcome: o.outcome }, 'Pipeline kept changing while a decision was applied; giving up');
  return { applied: false, because: 'contended' };
}

export interface ReviewDecisionInput {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly roleId: string | null;
  readonly disposition: string;
  readonly reason: string;
  readonly reviewerId: string;
}

/**
 * The verdict on an assessment review, applied to the candidate's pipeline:
 * PROCEED approves the AI interview stage, DO_NOT_PROGRESS rejects, CONSIDER
 * decides nothing. Null when there was no decision or no pipeline to carry
 * it to. The review itself has committed; like the events, a failure here is
 * logged loudly and never undoes it.
 */
export async function noteReviewDecision(o: ReviewDecisionInput): Promise<DecisionResult | null> {
  const outcome = decisionOfDisposition(o.disposition);
  if (!outcome || !o.roleId) return null;
  try {
    const pipeline = await ensurePipeline({ tenantId: o.tenantId, candidateId: o.candidateId, roleId: o.roleId, trigger: 'review.completed' });
    const result = await decidePipeline(pipeline, {
      tenantId: o.tenantId, outcome, reason: o.reason, about: { stageKind: 'ai_interview' },
      source: 'review', actorId: o.reviewerId, trigger: 'review.completed',
    });
    if (!result.applied && result.because === 'already_decided') {
      // A superseding verdict cannot reopen a closed pipeline: the earlier
      // decision stands until a person records otherwise.
      logger.warn({ pipelineId: pipeline.id, disposition: o.disposition }, 'Review verdict arrived for a pipeline already decided; left as it is');
    }
    return result;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), candidateId: o.candidateId }, 'Review verdict could not be applied to the pipeline');
    return null;
  }
}
