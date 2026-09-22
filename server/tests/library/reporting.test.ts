import { describe, expect, it } from 'vitest';
import type { InterviewPlan } from '../../src/domain/types.js';
import { orgLibrarySettings } from '../../src/library/orgSettings.js';
import { withoutLadders } from '../../src/library/planLadders.js';
import { questionsAsked } from '../../src/library/questionsAsked.js';
import { buildTrialReport, type TrialRow } from '../../src/library/trialReport.js';

/** What people see: questions asked, the paired trial report, the org switch, and plans without the library's content. */

const plan: InterviewPlan = {
  durationMinutes: 45, language: 'en', modules: [], coverageTargets: {},
  library: { mode: 'trial', rubricVersion: 'sc', roleSlug: 'r', band: 'senior', windowDays: 30, trialPercent: 50, selectedAt: '' },
  blocks: [
    { competencyId: '__process__', competencyName: 'Process', intent: '', targetMinutes: 2, followupHints: [], prohibited: [] },
    {
      competencyId: 'c1', competencyName: 'Incident Ownership', intent: '', targetMinutes: 6, followupHints: [], prohibited: [],
      library: { source: 'library', competencyKey: 'k1', trial: true, startRung: 0, ladder: [{ entryId: 'e1', standardId: null, questionText: 'Secret library question?', anchors: ['Secret anchor'], form: 'star', difficultyTag: 1 }] },
    },
    { competencyId: 'c2', competencyName: 'Data Modelling', intent: '', targetMinutes: 6, followupHints: [], prohibited: [], library: { source: 'builtin', reason: 'trial_control', competencyKey: 'k2', trial: true } },
    { competencyId: '__callback__', competencyName: 'Callback', intent: '', targetMinutes: 2, followupHints: [], prohibited: [] },
  ],
};

const stored = (speaker: string, competencyId: string, text: string, meta: Record<string, unknown> = {}) => ({ speaker, competencyId, text, metaJson: JSON.stringify(meta) });

describe('questionsAsked', () => {
  const turns = [
    stored('agent', '__process__', 'Hello there, what do you do?', { kind: 'opening' }),
    stored('agent', 'c1', 'Thanks. Take me to a failed run on your watch?', { kind: 'question', question: 'Take me to a failed run on your watch?', libraryEntryId: 'e1', rungMove: 'start' }),
    stored('candidate', 'c1', 'We had an outage.'),
    stored('agent', 'c1', 'Take your time.', { kind: 'pause' }),
    stored('agent', 'c2', 'How do you model a ledger?', { kind: 'transition' }),
    stored('agent', '__callback__', 'Going back to the outage — what would you change?', { kind: 'question' }),
  ];

  it('lists each question put, with its source', () => {
    expect(questionsAsked(plan, turns).map((q) => q.source)).toEqual(['library', 'builtin', 'callback']);
  });

  it('shows the question as spoken, without the lead-in', () => {
    expect(questionsAsked(plan, turns)[0].question).toBe('Take me to a failed run on your watch?');
  });

  it('never shows the library wording or anchors', () => {
    expect(JSON.stringify(questionsAsked(plan, turns))).not.toMatch(/Secret/);
  });
});

describe('withoutLadders', () => {
  it('keeps where each block comes from', () => {
    expect(withoutLadders(plan).blocks[1].library?.source).toBe('library');
  });

  it('drops the library questions and anchors', () => {
    expect(JSON.stringify(withoutLadders(plan))).not.toMatch(/Secret/);
  });

  it('returns a plan without the library as it is', () => {
    const { library: _library, ...plain } = plan;
    expect(withoutLadders(plain)).toBe(plain);
  });
});

describe('buildTrialReport', () => {
  const at = new Date('2026-09-22T10:00:00Z');
  const row = (session: string, competencyId: string, blockSource: string, evidenceYield: number | null, extra: Partial<TrialRow> = {}): TrialRow => ({
    interviewSessionId: session, competencyId, blockSource, outcome: 'answered', evidenceYield, probeCount: 1, confusionMarkers: 0, askedAt: at, ...extra,
  });
  const rows = [
    row('s1', 'c1', 'library', 0.8), row('s1', 'c1', 'library', 0.6), row('s1', 'c2', 'builtin', 0.5),
    row('s2', 'c1', 'builtin', 0.4, { confusionMarkers: 1 }), row('s2', 'c2', 'library', 0.6),
    row('s3', 'c1', 'library', 0.9),
  ];

  it('counts only interviews with both sides', () => {
    expect(buildTrialReport(rows).interviews).toBe(2);
  });

  it('counts a library block once however many rungs it asked', () => {
    expect(buildTrialReport(rows).library.blocks).toBe(2);
  });

  it('compares evidence yield within each interview', () => {
    expect(buildTrialReport(rows).pairedYieldDifference).toBeCloseTo(0.2, 3);
  });

  it('reports confusion per side', () => {
    expect(buildTrialReport(rows).builtin.confusionRate).toBe(0.5);
  });

  it('reports reviewer agreement once reviews exist', () => {
    const agreement = new Map([['s1', new Map([['c1', true], ['c2', false]])]]);
    expect(buildTrialReport(rows, agreement).library.reviewerAgreement).toBe(1);
  });

  it('says nothing about agreement before any review', () => {
    expect(buildTrialReport(rows).library.reviewerAgreement).toBeNull();
  });

  it('is empty before the trial', () => {
    expect(buildTrialReport([])).toMatchObject({ interviews: 0, pairedYieldDifference: null, firstAskedAt: null });
  });
});

describe('orgLibrarySettings', () => {
  it('is off for an organisation that has not chosen', () => {
    expect(orgLibrarySettings({}, { isDemo: false, defaultWindowDays: 30 }).mode).toBe('off');
  });

  it('runs the trial in the demo sandbox by default', () => {
    expect(orgLibrarySettings({}, { isDemo: true, defaultWindowDays: 30 }).mode).toBe('trial');
  });

  it('defaults the trial to half the blocks', () => {
    expect(orgLibrarySettings({ questionLibrary: 'trial' }, { isDemo: false, defaultWindowDays: 30 }).trialPercent).toBe(50);
  });

  it('defaults the no-repeat window to the library policy', () => {
    expect(orgLibrarySettings({ questionLibrary: 'on' }, { isDemo: false, defaultWindowDays: 30 }).windowDays).toBe(30);
  });

  it('takes the organisation window when set', () => {
    expect(orgLibrarySettings({ questionLibrary: 'on', questionLibraryWindowDays: 14 }, { isDemo: false, defaultWindowDays: 30 }).windowDays).toBe(14);
  });

  it('ignores a value it would refuse', () => {
    expect(orgLibrarySettings({ questionLibrary: 'always', questionLibraryTrialPercent: 150 }, { isDemo: false, defaultWindowDays: 30 })).toEqual({ mode: 'off', trialPercent: 50, windowDays: 30 });
  });
});
