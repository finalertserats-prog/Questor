import { describe, it, expect } from 'vitest';
import {
  ASSESSMENT_TABS, assessmentTabFromParam, assessmentTabPath, differenceRows, humanTabState,
  landingTab, levelText, nextAssessmentTab,
} from '../src/components/assessmentTabsModel';

/**
 * The assessment page's three tabs: what the reviewer decided, what the AI
 * produced, and where the two differ — the owner's "learning curve for the
 * AI". Addresses and keyboard movement follow the admin console's tabs.
 */

describe('the tabs', () => {
  it('reads Human, AI and the differences, in that order', () => {
    expect(ASSESSMENT_TABS.map((t) => t.key)).toEqual(['human', 'ai', 'differences']);
  });

  it('names them for the people using them', () => {
    expect(ASSESSMENT_TABS.map((t) => t.label)).toEqual(['Human review', 'AI assessment', 'Key differences']);
  });
});

describe('the address of each tab', () => {
  it('gives every tab an address of its own', () => {
    expect([assessmentTabPath('a1', 'human'), assessmentTabPath('a1', 'ai'), assessmentTabPath('a1', 'differences')])
      .toEqual(['/assessments/a1/human', '/assessments/a1/ai', '/assessments/a1/differences']);
  });

  it('reads a tab back out of an address', () => {
    expect(assessmentTabFromParam('differences')).toBe('differences');
  });

  it('lets the plain address choose for itself', () => {
    expect(assessmentTabFromParam(undefined)).toBeNull();
  });

  it('refuses an address that names no tab', () => {
    expect(assessmentTabFromParam('sideways')).toBeNull();
  });
});

describe('moving between them with the keyboard', () => {
  it('goes right and wraps', () => {
    expect([nextAssessmentTab('human', 'ArrowRight'), nextAssessmentTab('differences', 'ArrowRight')]).toEqual(['ai', 'human']);
  });

  it('goes left and wraps', () => {
    expect([nextAssessmentTab('ai', 'ArrowLeft'), nextAssessmentTab('human', 'ArrowLeft')]).toEqual(['human', 'differences']);
  });

  it('jumps to either end', () => {
    expect([nextAssessmentTab('ai', 'Home'), nextAssessmentTab('ai', 'End')]).toEqual(['human', 'differences']);
  });

  it('ignores any other key', () => {
    expect(nextAssessmentTab('ai', 'a')).toBe('ai');
  });
});

describe('which tab the page opens on', () => {
  it('opens on the human review once there is one', () => {
    expect(landingTab({ reviewed: true, requested: undefined })).toBe('human');
  });

  it('opens on the AI assessment while nobody has reviewed it', () => {
    expect(landingTab({ reviewed: false, requested: undefined })).toBe('ai');
  });

  it('honours the address whatever the state', () => {
    expect(landingTab({ reviewed: false, requested: 'differences' })).toBe('differences');
  });
});

describe('the human tab before anyone has reviewed', () => {
  it('explains that no review has been recorded yet', () => {
    expect(humanTabState(null).kind).toBe('none');
  });

  it('says what to do about it', () => {
    expect(humanTabState(null).message).toMatch(/no review/i);
  });

  it('shows the review once it exists', () => {
    const state = humanTabState({ disposition: 'CONSIDER', reason: 'r', comments: '', completedAt: '2026-09-20T10:00:00.000Z', reviewerId: 'u1' });
    expect(state.kind).toBe('reviewed');
  });
});

describe('how a level is shown', () => {
  it('reads as a level out of five', () => {
    expect(levelText(4)).toBe('4/5');
  });

  it('says plainly when there is none', () => {
    expect(levelText(null)).toBe('Not graded');
  });
});

describe('the differences', () => {
  const rows = [
    { competencyId: 'sql', competencyName: 'SQL', aiLevel: 4, humanLevel: 4, changed: false, reason: '' },
    { competencyId: 'stake', competencyName: 'Stakeholders', aiLevel: 2, humanLevel: 4, changed: true, reason: 'Stronger in person.' },
    { competencyId: 'lead', competencyName: 'Leadership', aiLevel: 3, humanLevel: 1, changed: true, reason: '' },
  ];

  it('puts what changed first, so the disagreement is what you read', () => {
    expect(differenceRows(rows).map((r) => r.competencyId)).toEqual(['stake', 'lead', 'sql']);
  });

  it('says which way the reviewer moved each one', () => {
    expect(differenceRows(rows).map((r) => r.direction)).toEqual(['up', 'down', 'same']);
  });

  it('keeps the reviewer’s reason, and says when they gave none', () => {
    expect(differenceRows(rows).map((r) => r.reason)).toEqual(['Stronger in person.', 'No reason given.', '']);
  });
});
