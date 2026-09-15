/**
 * Display logic for the candidate pipeline panel, kept free of React so it can
 * be unit tested in the node test environment (see web/tests/pipelineView.test.ts).
 */

export type StageKind = 'intake' | 'profile_review' | 'ai_interview' | 'human_interview';

export interface PipelineStageView {
  readonly key: string;
  readonly label: string;
  readonly kind: StageKind;
}

export type StageState = 'done' | 'current' | 'upcoming' | 'decided' | 'skipped';

/** Where each stage stands relative to the candidate's current stage. */
export function stageStates(stages: readonly PipelineStageView[], currentKey: string, status: string): StageState[] {
  const currentIndex = stages.findIndex((stage) => stage.key === currentKey);
  const decided = status === 'DECIDED';
  return stages.map((_, index) => {
    if (index < currentIndex) return 'done';
    if (index > currentIndex) return decided ? 'skipped' : 'upcoming';
    return decided ? 'decided' : 'current';
  });
}

const CAPTIONS: Record<StageKind, string> = {
  intake: 'Onboarding',
  profile_review: 'Profile review',
  ai_interview: 'AI interview',
  human_interview: 'Human interview',
};

/** A short, human description of what happens at a stage of this kind. */
export function stageCaption(kind: StageKind): string {
  return CAPTIONS[kind];
}

/** The stage after `currentKey`, or null at the final stage. */
export function nextStage(stages: readonly PipelineStageView[], currentKey: string): PipelineStageView | null {
  const index = stages.findIndex((stage) => stage.key === currentKey);
  return index >= 0 && index < stages.length - 1 ? stages[index + 1] : null;
}
