import type { CandidatePipeline, Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { logAudit } from './audit.js';
import { DEFAULT_STAGES, nextStageKey, parseStages, parseStagesStrict, type StageKind } from '../domain/pipelineStages.js';
import {
  resolveDecision, resolveTransition,
  type DecisionEffect, type DecisionOutcome, type PipelineEvent, type StageTransition,
} from '../domain/pipelineAutonomy.js';
import { decisionOfVerdict, type Verdict } from '../domain/verdict.js';
import { outcomeNeedsHumanReview, type UnreviewedInterview } from '../domain/humanReviewRule.js';
import { humanReviewCheck, type HumanReviewRecord } from './humanReviewGate.js';
import { awardOnPromotion, isAwardConflict, noteAwards, type StruckAward } from './candidateAwards.js';

/**
 * Applies the candidate journey (domain/pipelineAutonomy.ts) to the database:
 * the part that still happens by itself, and the decisions a person records.
 *
 * Called from the places where the events actually happen — candidate
 * creation, resume analysis, interview creation and scheduling, assessment —
 * never from a timer. The primary write has already committed by then, so a
 * failure here is logged and never turns a created interview into a 500.
 *
 * Most of those events no longer move anybody, and are still called: they
 * start a pipeline for a candidate who has none, which is what keeps an
 * interview booked before anyone touched the pipeline from having nowhere to
 * belong.
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
 * stage the winner left, so two events arriving at once end at the further of
 * the two whichever commits first.
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

interface MoveAndAwardOutcome {
  readonly written: { readonly count: number };
  readonly awards: StruckAward[];
}

/**
 * The move and the badges it earns, as one transaction. Null when a tier was
 * struck under us — another move for the same candidate landed first, which is
 * contention and is reported as such rather than surfacing as a crash to
 * whoever recorded the decision.
 */
async function runMoveAndAward(run: (tx: Prisma.TransactionClient) => Promise<MoveAndAwardOutcome>): Promise<MoveAndAwardOutcome | null> {
  try {
    return await prisma.$transaction(run);
  } catch (err) {
    if (isAwardConflict(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The Advance button
// ---------------------------------------------------------------------------

export interface PipelineAdvanceInput {
  readonly tenantId: string;
  /** Where the caller means to move them. It must be the stage after the one they are at. */
  readonly toStageKey: string;
  /** The person moving them. The system never advances anybody. */
  readonly actorId: string;
  readonly trigger: string;
}

/** The stage a refused advance would have gone to, so a caller can name it. */
export interface NextStage {
  readonly key: string;
  readonly label: string;
}

export type AdvanceResult =
  | { readonly applied: true; readonly transition: StageTransition; readonly awards: readonly StruckAward[] }
  | { readonly applied: false; readonly because: 'already_decided' | 'at_last_stage' | 'contended' }
  | { readonly applied: false; readonly because: 'not_next'; readonly next: NextStage };

/**
 * Move a candidate on one stage, because a person said so.
 *
 * Here rather than in the route because it is not only the route's any more.
 * Since the assessment stopped moving anybody (domain/pipelineAutonomy.ts),
 * this is the move that gets a candidate to the AI round — the one the "Needs
 * you" queue asks for — and the demo sandbox stages its candidates with it
 * too, so that what a prospect is shown is the product's own arithmetic rather
 * than a tableau assembled behind its back.
 *
 * The move and the badges it earns commit together or not at all. A journey
 * showing a candidate at Gold with no Silver badge, or a Silver badge for a
 * move that rolled back, is a record that contradicts itself with nothing to
 * say which half is right.
 *
 * Refusals are returned rather than thrown, so each caller answers them in its
 * own terms: the route turns them into a message the person can act on, and
 * the sandbox logs one loudly.
 */
export async function advancePipeline(loaded: CandidatePipeline, o: PipelineAdvanceInput): Promise<AdvanceResult> {
  if (loaded.status !== 'ACTIVE') return { applied: false, because: 'already_decided' };
  const stages = parseStagesStrict(loaded.stagesJson, { model: 'CandidatePipeline', id: loaded.id, field: 'stagesJson' });
  const next = nextStageKey(stages, loaded.currentStageKey);
  if (!next) return { applied: false, because: 'at_last_stage' };
  if (o.toStageKey !== next) {
    return { applied: false, because: 'not_next', next: { key: next, label: stages.find((s) => s.key === next)?.label ?? next } };
  }

  const outcome = await runMoveAndAward(async (tx) => {
    // Conditional on the stage that was read, so two people advancing at once
    // cannot both succeed.
    const written = await tx.candidatePipeline.updateMany({
      where: { id: loaded.id, status: 'ACTIVE', currentStageKey: loaded.currentStageKey },
      data: { currentStageKey: next },
    });
    if (written.count !== 1) return { written, awards: [] as StruckAward[] };
    return {
      written,
      awards: await awardOnPromotion(tx, {
        tenantId: o.tenantId, candidateId: loaded.candidateId, roleId: loaded.roleId,
        stages, fromStageKey: loaded.currentStageKey, toStageKey: next, actorId: o.actorId,
      }),
    };
  });
  // A tier struck under us means another move landed first, which is the same
  // answer the conditional update gives.
  if (!outcome || outcome.written.count !== 1) return { applied: false, because: 'contended' };

  await logAudit({
    tenantId: o.tenantId, actorType: 'user', actorId: o.actorId,
    action: 'pipeline.advanced', entityType: 'CandidatePipeline', entityId: loaded.id,
    // What this move struck is not repeated here: each badge writes its own
    // award.struck event, with the reference a holder would quote. Two records
    // of one fact is two things to keep in step.
    before: { stage: loaded.currentStageKey }, after: { stage: next },
  });
  // After the commit, so the trail can never claim a badge that rolled back.
  await noteAwards({ tenantId: o.tenantId, actorId: o.actorId, candidateId: loaded.candidateId, awards: outcome.awards });
  return { applied: true, transition: { from: loaded.currentStageKey, to: next }, awards: outcome.awards };
}

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
  | { readonly applied: true; readonly effect: DecisionEffect; readonly humanReview: HumanReviewRecord; readonly awards: readonly StruckAward[] }
  | { readonly applied: false; readonly because: 'already_decided' | 'nothing_to_do' | 'contended' }
  // The candidate was promised a person would review their interview and none
  // has. Reported rather than thrown so every caller has to answer it: the
  // endpoint turns it into a refusal the reviewer can act on, and the verdict
  // path records that the journey did not move.
  | { readonly applied: false; readonly because: 'human_review_required'; readonly missing: UnreviewedInterview };

async function auditDecision(
  pipeline: CandidatePipeline, o: PipelineDecisionInput, effect: DecisionEffect, about: string, humanReview: HumanReviewRecord,
): Promise<void> {
  const actor = { tenantId: o.tenantId, actorType: 'user' as const, actorId: o.actorId, entityType: 'CandidatePipeline', entityId: pipeline.id };
  if (effect.kind === 'close') {
    await logAudit({
      ...actor, action: 'pipeline.decided',
      // humanReview is the record the candidate's consent screen is about: it
      // says whether a person was required to read their interview and whether
      // one had, at the moment this outcome was written.
      after: { decision: effect.outcome, stage: effect.atStageKey, about, source: o.source, trigger: o.trigger, reasonRecorded: true, humanReview },
    });
    return;
  }
  // Reaching the last stage is a finalisation whoever's button it was, so the
  // trail reads the same as the Finalise endpoint's.
  await logAudit({
    ...actor, action: effect.final ? 'pipeline.finalized' : 'pipeline.advanced',
    before: { stage: effect.from }, after: { stage: effect.to, decision: o.outcome, source: o.source, trigger: o.trigger, humanReview },
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

  // The promise, checked once before the loop.
  //
  // Here rather than in the endpoint because this is the only function in the
  // server that writes a hiring outcome. Putting the rule at the single write
  // means a new way to record a decision inherits it instead of having to
  // remember it — which is exactly how `humanReviewRequired` came to be stored
  // by one route and read by none.
  //
  // Deliberately outside the retry loop: the answer cannot change from a
  // contended stage move, and re-reading the candidate's whole interview
  // history on every attempt would pay for a fact we already have.
  const review = await humanReviewCheck({ tenantId: o.tenantId, candidateId: pipeline.candidateId, roleId: pipeline.roleId });
  if (review.missing && outcomeNeedsHumanReview(o.outcome)) {
    return { applied: false, because: 'human_review_required', missing: review.missing };
  }
  // A withdrawal is recorded whatever the review says, and the record says so:
  // "the promise applied, and this decision was exempt from it" is a different
  // fact from "the promise was kept", and a year from now only one of them is
  // true of this candidate.
  const humanReview: HumanReviewRecord = review.missing
    ? { required: true, missingFor: review.missing.assessmentId }
    : review.record;

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

    // An approval that advances a candidate is a person moving them, so it
    // earns whatever tiers that move earns — Silver → Gold strikes Silver, and
    // Gold → Diamond strikes Gold and Diamond together. Written in the same
    // transaction as the move: a candidate shown at Gold with no Silver badge,
    // or holding a badge for a move that rolled back, is a record that
    // contradicts itself.
    const outcome = await runMoveAndAward(async (tx) => {
      if (effect.kind !== 'advance') {
        return {
          written: await tx.candidatePipeline.updateMany({
            where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: effect.atStageKey },
            data: {
              status: 'DECIDED', decision: effect.outcome, decisionReason: o.reason,
              decidedAtStageKey: effect.atStageKey, decidedById: o.actorId, decidedAt: new Date(),
            },
          }),
          awards: [] as StruckAward[],
        };
      }
      const moved = await tx.candidatePipeline.updateMany({
        where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: effect.from },
        data: { currentStageKey: effect.to },
      });
      if (moved.count !== 1) return { written: moved, awards: [] as StruckAward[] };
      return {
        written: moved,
        awards: await awardOnPromotion(tx, {
          tenantId: o.tenantId, candidateId: pipeline.candidateId, roleId: pipeline.roleId,
          stages, fromStageKey: effect.from, toStageKey: effect.to, actorId: o.actorId,
        }),
      };
    });
    // A tier struck under us means another move landed first, which is the
    // same answer the conditional update gives: reported, never a crash.
    if (!outcome) return { applied: false, because: 'contended' };
    const { written, awards } = outcome;
    if (written.count === 1) {
      await auditDecision(pipeline, o, effect, about, humanReview);
      // After the commit, so the trail can never claim a badge that rolled back.
      await noteAwards({ tenantId: o.tenantId, actorId: o.actorId, candidateId: pipeline.candidateId, awards });
      return { applied: true, effect, humanReview, awards };
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
  readonly verdict: Verdict;
  readonly reason: string;
  readonly reviewerId: string;
}

/**
 * The verdict on an assessment review, applied to the candidate's pipeline:
 * Proceed approves the AI interview stage, Do not progress ends the journey,
 * Consider decides nothing. Null when there was no decision or no pipeline to
 * carry it to. The review itself has committed; like the events, a failure
 * here is logged loudly and never undoes it.
 */
export async function noteReviewDecision(o: ReviewDecisionInput): Promise<DecisionResult | null> {
  const outcome = decisionOfVerdict(o.verdict);
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
      logger.warn({ pipelineId: pipeline.id, verdict: o.verdict }, 'Review verdict arrived for a pipeline already decided; left as it is');
    }
    if (!result.applied && result.because === 'human_review_required') {
      // This review IS a human review, so the usual case passes. What is left
      // is a candidate with a SECOND AI interview nobody has read — a real
      // thing the reviewer should know about, not a bug. The verdict stands as
      // a review; the journey waits for the other interview to be read, and
      // the caller reports that to the page rather than claiming a move.
      logger.warn(
        { pipelineId: pipeline.id, verdict: o.verdict, assessmentId: result.missing.assessmentId },
        'Review verdict could not move the candidate: another AI interview of theirs still has no human review',
      );
    }
    return result;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), candidateId: o.candidateId }, 'Review verdict could not be applied to the pipeline');
    return null;
  }
}
