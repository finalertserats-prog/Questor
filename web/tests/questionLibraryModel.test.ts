import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRIAL_PERCENT, DEFAULT_WINDOW_DAYS, LIBRARY_MODE_OPTIONS, libraryModePatch, libraryNumbersPatch, librarySettingsOf,
} from '../src/components/questionLibraryModel';
import { groupQuestions, librarySummary, sourceLabel, type AskedQuestion } from '../src/components/questionsAskedModel';
import { comparisonRows, trialStanding, type TrialReport } from '../src/components/library/trialReportModel';

describe('the question library switch', () => {
  it('shows off for an organisation that has not chosen', () => {
    expect(librarySettingsOf({}).mode).toBe('off');
  });

  it('shows the defaults the server applies', () => {
    expect(librarySettingsOf({ questionLibrary: 'trial' })).toEqual({ mode: 'trial', trialPercent: DEFAULT_TRIAL_PERCENT, windowDays: DEFAULT_WINDOW_DAYS });
  });

  it('shows a value the server would refuse as the default', () => {
    expect(librarySettingsOf({ questionLibrary: 'sometimes', questionLibraryWindowDays: 0 })).toEqual({ mode: 'off', trialPercent: 50, windowDays: 30 });
  });

  it('offers off, trial and on', () => {
    expect(LIBRARY_MODE_OPTIONS.map((o) => o.mode)).toEqual(['off', 'trial', 'on']);
  });

  it('saves the mode on its own', () => {
    expect(libraryModePatch('trial')).toEqual({ policy: { questionLibrary: 'trial' } });
  });

  it('saves the trial share and window together', () => {
    expect(libraryNumbersPatch(10, 45)).toEqual({ policy: { questionLibraryTrialPercent: 10, questionLibraryWindowDays: 45 } });
  });

  it('refuses a window longer than a year', () => {
    expect(libraryNumbersPatch(50, 400)).toBeNull();
  });

  it('refuses a share over 100', () => {
    expect(libraryNumbersPatch(120, 30)).toBeNull();
  });
});

describe('questions asked', () => {
  const qs: AskedQuestion[] = [
    { competencyId: 'c1', competencyName: 'Incidents', source: 'library', question: 'Take me to a failed run?', rungMove: 'start' },
    { competencyId: 'c1', competencyName: 'Incidents', source: 'library', question: 'At ten times the volume?', rungMove: 'up' },
    { competencyId: 'c2', competencyName: 'Ledgers', source: 'builtin', question: 'How do you model refunds?' },
    { competencyId: '__callback__', competencyName: 'Callback', source: 'callback', question: 'Going back to the outage?' },
  ];

  it('groups the questions by competency in the order asked', () => {
    expect(groupQuestions(qs).map((g) => [g.competencyName, g.questions.length])).toEqual([['Incidents', 2], ['Ledgers', 1], ['Callback', 1]]);
  });

  it('says a library question stepped up the ladder', () => {
    expect(sourceLabel(qs[1])).toBe('question library, harder step');
  });

  it('names a built-in question', () => {
    expect(sourceLabel(qs[2])).toBe('built-in question');
  });

  it('names the callback', () => {
    expect(sourceLabel(qs[3])).toBe('callback to an earlier answer');
  });

  it('sums up how many drew on the library', () => {
    expect(librarySummary(qs)).toBe("4 questions asked; 2 drew on the question library, in the interviewer's own words.");
  });
});

describe('the trial report', () => {
  const side = { blocks: 0, meanYield: null, nonAnswerRate: null, confusionRate: null, meanProbes: null, reviewerAgreement: null, reviewedBlocks: 0 };
  const empty: TrialReport = { interviews: 0, library: side, builtin: side, pairedYieldDifference: null, firstAskedAt: null, targetBlocks: 100 };

  it('says the trial has not started', () => {
    expect(trialStanding(empty)).toMatch(/^No paired interviews yet/);
  });

  it('gives no verdict before the target', () => {
    const early = { ...empty, interviews: 3, library: { ...side, blocks: 4 }, pairedYieldDifference: 0.3 };
    expect(trialStanding(early)).toMatch(/Too early to compare\.$/);
  });

  it('says which side yields more once the target is reached', () => {
    const done = { ...empty, interviews: 60, library: { ...side, blocks: 120 }, pairedYieldDifference: 0.08 };
    expect(trialStanding(done)).toMatch(/Library blocks yield more evidence/);
  });

  it('shows a dash for a measure with no data', () => {
    expect(comparisonRows(empty).find((r) => r.label === 'Evidence yield (mean)')?.library).toBe('—');
  });
});
