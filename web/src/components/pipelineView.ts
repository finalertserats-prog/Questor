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

/**
 * The stage a person finalises the candidate into — the last one, Diamond by
 * default — or null when the candidate is already there. Nothing reaches it on
 * its own, so the panel offers it as a separate, confirmed action.
 */
export function finalStage(stages: readonly PipelineStageView[], currentKey: string): PipelineStageView | null {
  const index = stages.findIndex((stage) => stage.key === currentKey);
  return index >= 0 && index < stages.length - 1 ? stages[stages.length - 1] : null;
}

/** The fields of a pipeline the outcome line reads. */
export interface PipelineStanding {
  readonly currentStageKey: string;
  readonly status: string;
  readonly decision: string | null;
  readonly decidedAtStageKey: string | null;
}

export interface PipelineOutcome {
  /** True once the journey has ended: nothing after this is a stage. */
  readonly final: boolean;
  readonly text: string;
}

/**
 * Where the journey stands, in one sentence. Decisions move candidates on
 * their own (server: domain/pipelineAutonomy.ts), so the panel and the journey
 * board both read this rather than each inferring it — and a rejection reads
 * as the end of the journey, never as a stage still to come.
 */
export function pipelineOutcome(stages: readonly PipelineStageView[], pipeline: PipelineStanding): PipelineOutcome {
  const labelOf = (key: string) => stages.find((stage) => stage.key === key)?.label ?? key;
  if (pipeline.status === 'DECIDED') {
    const at = labelOf(pipeline.decidedAtStageKey ?? pipeline.currentStageKey);
    if (pipeline.decision === 'REJECTED') return { final: true, text: `Not progressing. The journey ended at ${at}.` };
    if (pipeline.decision === 'WITHDRAWN') return { final: true, text: `The candidate withdrew at ${at}. The journey ended there.` };
    if (pipeline.decision === 'APPROVED') return { final: true, text: `Approved at ${at}. The journey is complete.` };
    return { final: true, text: `Decided at ${at}.` };
  }
  const index = stages.findIndex((stage) => stage.key === pipeline.currentStageKey);
  const current = index >= 0 ? stages[index] : null;
  const label = labelOf(pipeline.currentStageKey);
  if (current && index === stages.length - 1) return { final: false, text: `Finalised as ${label}. A person records the final outcome.` };
  if (current?.kind === 'human_interview') return { final: false, text: `Progressing to the next round: ${label}.` };
  return { final: false, text: `In progress: ${label}.` };
}
