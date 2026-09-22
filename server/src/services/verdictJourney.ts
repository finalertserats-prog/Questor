import { prisma } from '../db.js';
import { DEFAULT_STAGES, parseStages, type PipelineStage } from '../domain/pipelineStages.js';
import { verdictConsequences, type VerdictConsequence } from '../domain/verdictConsequence.js';
import type { DecisionOutcome } from '../domain/pipelineAutonomy.js';

/**
 * The candidate's journey as the assessment page needs it: where they stand,
 * and what each verdict would do to that.
 *
 * The page promises a consequence before the reviewer commits to it, so the
 * promise is computed from the same stage plan the submit will act on, by the
 * same function (domain/verdictConsequence.ts). What actually happened is then
 * reported by comparing a snapshot taken before the submit with the row after
 * it — the record, not a second prediction.
 */

export interface JourneyStanding {
  readonly pipelineId: string;
  readonly currentStageKey: string;
  readonly status: string;
  readonly decision: string | null;
}

export interface JourneyView extends JourneyStanding {
  readonly stages: readonly PipelineStage[];
  readonly currentStageLabel: string;
  readonly consequences: readonly VerdictConsequence[];
  /**
   * A letter is queued for the candidate that completing a review releases
   * (services/autoFeedback.ts, gateReviewCompletion). The page says so before
   * the reviewer decides, because an email cannot be unsent.
   */
  readonly letterWaiting: boolean;
}

/** The statuses gateReviewCompletion releases when a review completes. */
const RELEASABLE = ['QUEUED', 'SENDING'];

function labelOf(stages: readonly PipelineStage[], key: string): string {
  return stages.find((stage) => stage.key === key)?.label ?? key;
}

async function pipelineFor(candidateId: string, roleId: string | null) {
  if (!roleId) return null;
  return prisma.candidatePipeline.findFirst({ where: { candidateId, roleId } });
}

/** Where the candidate stands right now, or null when they have no pipeline for this role. */
export async function journeyStanding(candidateId: string, roleId: string | null): Promise<JourneyStanding | null> {
  const pipeline = await pipelineFor(candidateId, roleId);
  if (!pipeline) return null;
  return {
    pipelineId: pipeline.id, currentStageKey: pipeline.currentStageKey,
    status: pipeline.status, decision: pipeline.decision,
  };
}

/**
 * The journey and every verdict's consequence. Null when the candidate has no
 * pipeline yet: the review still records, and the page says so rather than
 * promising a move it cannot describe.
 */
export async function journeyFor(candidateId: string, roleId: string | null, assessmentId: string): Promise<JourneyView | null> {
  const pipeline = await pipelineFor(candidateId, roleId);
  if (!pipeline) return null;
  // Not the strict parse: a plan nobody can read must not take the whole
  // assessment page down with it, and the defaults describe what the
  // autonomous journey would do anyway.
  const stages = pipeline.stagesJson ? parseStages(pipeline.stagesJson) : DEFAULT_STAGES.map((s) => ({ ...s }));
  const letter = await prisma.candidateFeedbackEmail.findFirst({
    where: { assessmentId, status: { in: RELEASABLE } }, select: { id: true },
  });
  return {
    pipelineId: pipeline.id,
    stages,
    currentStageKey: pipeline.currentStageKey,
    currentStageLabel: labelOf(stages, pipeline.currentStageKey),
    status: pipeline.status,
    decision: pipeline.decision,
    consequences: verdictConsequences(stages, pipeline.currentStageKey, pipeline.status),
    letterWaiting: letter !== null,
  };
}

/** What a submit actually did to the journey, read off the two snapshots. */
export interface JourneyMove {
  readonly fromStageKey: string;
  readonly fromStageLabel: string;
  readonly toStageKey: string;
  readonly toStageLabel: string;
  readonly moves: boolean;
  readonly closes: DecisionOutcome | null;
}

export async function journeyMove(before: JourneyStanding, stages: readonly PipelineStage[]): Promise<JourneyMove> {
  const after = await prisma.candidatePipeline.findUnique({ where: { id: before.pipelineId } });
  const toStageKey = after?.currentStageKey ?? before.currentStageKey;
  // Only a close this submit caused counts: a pipeline decided before it
  // started was not closed by this verdict.
  const closed = after?.status === 'DECIDED' && before.status !== 'DECIDED' ? after.decision : null;
  return {
    fromStageKey: before.currentStageKey,
    fromStageLabel: labelOf(stages, before.currentStageKey),
    toStageKey,
    toStageLabel: labelOf(stages, toStageKey),
    moves: toStageKey !== before.currentStageKey,
    closes: (closed as DecisionOutcome | null) ?? null,
  };
}
