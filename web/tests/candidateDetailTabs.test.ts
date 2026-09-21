import { describe, it, expect } from 'vitest';
import { candidateDetailTabs, candidateDetailTabFromParam, nextCandidateDetailTab, candidateDetailPanelId, candidateDetailTabId } from '../src/pages/CandidateDetail';

describe('candidate detail tab model', () => {
  it('defaults to the candidate profile tab', () => {
    expect(candidateDetailTabs[0]).toMatchObject({ key: 'profile', label: 'Candidate profile' });
  });

  it('uses stable linked tab and panel ids for assistive tech', () => {
    for (const tab of candidateDetailTabs) {
      expect(candidateDetailTabId(tab.key)).toBe(`candidate-detail-${tab.key}-tab`);
      expect(candidateDetailPanelId(tab.key)).toBe(`candidate-detail-${tab.key}-panel`);
    }
  });

  it('moves right and left with wraparound', () => {
    expect(nextCandidateDetailTab('profile', 'ArrowRight')).toBe('journey');
    expect(nextCandidateDetailTab('journey', 'ArrowRight')).toBe('profile');
    expect(nextCandidateDetailTab('profile', 'ArrowLeft')).toBe('journey');
    expect(nextCandidateDetailTab('journey', 'ArrowLeft')).toBe('profile');
  });

  it('supports Home and End and ignores other keys', () => {
    expect(nextCandidateDetailTab('journey', 'Home')).toBe('profile');
    expect(nextCandidateDetailTab('profile', 'End')).toBe('journey');
    expect(nextCandidateDetailTab('profile', 'Tab')).toBe('profile');
  });
});

describe('candidateDetailTabFromParam', () => {
  it('opens the journey tab when the link asks for it', () => {
    expect(candidateDetailTabFromParam('journey')).toBe('journey');
  });

  it('opens the profile tab for anything else', () => {
    expect(candidateDetailTabFromParam('nonsense')).toBe('profile');
  });
});
