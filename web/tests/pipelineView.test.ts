import { describe, it, expect } from 'vitest';
import { stageStates, stageCaption, nextStage, finalStage, pipelineOutcome } from '../src/components/pipelineView';

const STAGES = [
  { key: 'participation', label: 'Participation', kind: 'intake' },
  { key: 'bronze', label: 'Bronze', kind: 'profile_review' },
  { key: 'silver', label: 'Silver', kind: 'ai_interview' },
  { key: 'gold', label: 'Gold', kind: 'human_interview' },
] as const;

describe('stageStates', () => {
  it('marks earlier stages done, the current one current and later ones upcoming', () => {
    expect(stageStates(STAGES, 'silver', 'ACTIVE')).toEqual(['done', 'done', 'current', 'upcoming']);
  });

  it('marks the stage where a decision was made as decided and later stages as skipped', () => {
    expect(stageStates(STAGES, 'bronze', 'DECIDED')).toEqual(['done', 'decided', 'skipped', 'skipped']);
  });
});

describe('stageCaption', () => {
  it('describes the AI-conducted interview stage', () => {
    expect(stageCaption('ai_interview')).toBe('AI interview');
  });

  it('describes a human-led interview stage', () => {
    expect(stageCaption('human_interview')).toBe('Human interview');
  });
});

describe('nextStage', () => {
  it('returns the stage after the current one', () => {
    expect(nextStage(STAGES, 'bronze')?.label).toBe('Silver');
  });

  it('returns null at the final stage', () => {
    expect(nextStage(STAGES, 'gold')).toBeNull();
  });
});

describe('finalStage', () => {
  it('offers the last stage from any earlier one', () => {
    expect(finalStage(STAGES, 'participation')?.label).toBe('Gold');
  });

  it('offers nothing once the candidate is at the last stage', () => {
    expect(finalStage(STAGES, 'gold')).toBeNull();
  });

  it('offers nothing when the current stage is not in the plan', () => {
    expect(finalStage(STAGES, 'platinum')).toBeNull();
  });
});

/**
 * The one line that says where the journey stands — written from the pipeline
 * the server holds, so the panel and the journey board can never disagree.
 */
describe('pipelineOutcome', () => {
  const FIVE = [...STAGES, { key: 'diamond', label: 'Diamond', kind: 'human_interview' }] as const;
  const active = (currentStageKey: string) => ({ currentStageKey, status: 'ACTIVE', decision: null, decidedAtStageKey: null });
  const decided = (decision: string, decidedAtStageKey: string) => ({ currentStageKey: decidedAtStageKey, status: 'DECIDED', decision, decidedAtStageKey });

  it('says a rejected candidate is not progressing, and where the journey ended', () => {
    expect(pipelineOutcome(FIVE, decided('REJECTED', 'gold'))).toEqual({ final: true, text: 'Not progressing. The journey ended at Gold.' });
  });

  it('says a withdrawn candidate withdrew', () => {
    expect(pipelineOutcome(FIVE, decided('WITHDRAWN', 'silver'))).toEqual({ final: true, text: 'The candidate withdrew at Silver. The journey ended there.' });
  });

  it('says an approved candidate completed the journey', () => {
    expect(pipelineOutcome(FIVE, decided('APPROVED', 'diamond'))).toEqual({ final: true, text: 'Approved at Diamond. The journey is complete.' });
  });

  it('says a candidate at a human round is progressing to the next round', () => {
    expect(pipelineOutcome(FIVE, active('gold'))).toEqual({ final: false, text: 'Progressing to the next round: Gold.' });
  });

  it('says a finalised candidate awaits the final decision', () => {
    expect(pipelineOutcome(FIVE, active('diamond'))).toEqual({ final: false, text: 'Finalised as Diamond. A person records the final outcome.' });
  });

  it('names the stage for a candidate still before the human rounds', () => {
    expect(pipelineOutcome(FIVE, active('silver'))).toEqual({ final: false, text: 'In progress: Silver.' });
  });

  it('falls back to the current stage when a decided pipeline does not say where', () => {
    expect(pipelineOutcome(FIVE, { currentStageKey: 'bronze', status: 'DECIDED', decision: 'REJECTED', decidedAtStageKey: null }).text).toContain('Bronze');
  });

  it('shows the raw key rather than nothing when the stage is not in the plan', () => {
    expect(pipelineOutcome(FIVE, active('platinum')).text).toBe('In progress: platinum.');
  });
});
