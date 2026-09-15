import { describe, it, expect } from 'vitest';
import { stageStates, stageCaption, nextStage } from '../src/components/pipelineView';

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
