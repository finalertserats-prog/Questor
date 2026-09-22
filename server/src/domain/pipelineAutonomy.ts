import type { PipelineStage, StageKind } from './pipelineStages.js';

/**
 * The autonomous candidate journey.
 *
 * Events in the hiring process move a candidate forward through their
 * pipeline without anyone pressing "Move to …":
 *
 *   candidate.onboarded   the candidate exists            → Participation
 *   candidate.profiled    their resume has been analysed  → Bronze
 *   interview.scheduled   an AI interview exists for them → Silver
 *   interview.assessed    an AI interview was assessed    → Gold
 *   candidate.finalized   a person finalised them         → Diamond
 *
 * Two rules hold for every event. A candidate only ever moves FORWARD: a
 * second interview scheduled at Gold leaves them at Gold, and nothing here
 * demotes anyone. And the last stage is never reached by an event the system
 * raises on its own — only a person's explicit finalisation gets there.
 *
 * Stage plans are per role, so events name the KIND of stage they reach
 * rather than a key; a plan without a stage of that kind simply ignores the
 * event.
 */

export const PIPELINE_EVENTS = [
  'candidate.onboarded', 'candidate.profiled', 'interview.scheduled', 'interview.assessed', 'candidate.finalized',
] as const;
export type PipelineEvent = (typeof PIPELINE_EVENTS)[number];

export interface StageTransition {
  readonly from: string;
  readonly to: string;
}

const KIND_OF_EVENT: Readonly<Record<Exclude<PipelineEvent, 'candidate.finalized'>, StageKind>> = {
  'candidate.onboarded': 'intake',
  'candidate.profiled': 'profile_review',
  'interview.scheduled': 'ai_interview',
  'interview.assessed': 'human_interview',
};

/**
 * The stage an event reaches in this plan, or null when the plan has none of
 * that kind. The last stage belongs to finalisation alone: a plan whose only
 * human stage is also its last one gives an assessment nowhere to go.
 */
export function targetStageKey(stages: readonly PipelineStage[], event: PipelineEvent): string | null {
  if (event === 'candidate.finalized') return stages.length > 0 ? stages[stages.length - 1].key : null;
  const kind = KIND_OF_EVENT[event];
  return stages.slice(0, -1).find((stage) => stage.kind === kind)?.key ?? null;
}

/**
 * The forward move an event causes from `currentStageKey`, or null when it
 * causes none: the target is missing, already reached, or behind the
 * candidate. Applying the same event twice therefore resolves to nothing the
 * second time.
 */
export function resolveTransition(stages: readonly PipelineStage[], currentStageKey: string, event: PipelineEvent): StageTransition | null {
  const target = targetStageKey(stages, event);
  if (!target) return null;
  const fromIndex = stages.findIndex((stage) => stage.key === currentStageKey);
  const toIndex = stages.findIndex((stage) => stage.key === target);
  if (fromIndex < 0 || toIndex <= fromIndex) return null;
  return { from: currentStageKey, to: target };
}

/**
 * Decisions. A person records one — as the verdict on an assessment review, or
 * on the pipeline itself — and the pipeline follows it without anyone pressing
 * "Move to …" afterwards:
 *
 *   APPROVED at a stage    → the stage after it (Silver → Gold, Gold → Diamond);
 *                            at the last stage, the pipeline closes approved
 *   REJECTED / WITHDRAWN   → the pipeline closes with that outcome, where it is
 *
 * Approval is the one decision that moves anyone, and it obeys the same two
 * rules as the events above: forward only, and approving a stage the candidate
 * has already left changes nothing. It is also how the last stage is reached
 * without the Finalise button — still a person's decision, only recorded once.
 */

export const DECISION_OUTCOMES = ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type DecisionEffect =
  | { readonly kind: 'advance'; readonly from: string; readonly to: string; readonly final: boolean }
  | { readonly kind: 'close'; readonly outcome: DecisionOutcome; readonly atStageKey: string };

/**
 * What a decision about `aboutStageKey` does to a candidate at
 * `currentStageKey`, or null when it does nothing. A rejection or withdrawal
 * closes the pipeline at the stage the candidate is actually at — the decision
 * may be about an earlier round, but nobody is moved back to it.
 */
export function resolveDecision(
  stages: readonly PipelineStage[], currentStageKey: string, outcome: DecisionOutcome, aboutStageKey: string,
): DecisionEffect | null {
  if (outcome !== 'APPROVED') return { kind: 'close', outcome, atStageKey: currentStageKey };
  const currentIndex = stages.findIndex((stage) => stage.key === currentStageKey);
  const aboutIndex = stages.findIndex((stage) => stage.key === aboutStageKey);
  if (currentIndex < 0 || aboutIndex < 0) return null;
  const lastIndex = stages.length - 1;
  if (aboutIndex === lastIndex) {
    return currentIndex === lastIndex ? { kind: 'close', outcome, atStageKey: currentStageKey } : null;
  }
  const toIndex = aboutIndex + 1;
  if (toIndex <= currentIndex) return null;
  return { kind: 'advance', from: currentStageKey, to: stages[toIndex].key, final: toIndex === lastIndex };
}

/*
 * The decision a reviewer's verdict amounts to lives in domain/verdict.ts
 * (decisionOfVerdict). There is one vocabulary for that judgement and one
 * place the two stored enums are allowed to meet; it is not here.
 */
