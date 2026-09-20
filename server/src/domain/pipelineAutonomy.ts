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
