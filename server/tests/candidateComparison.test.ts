import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DIRECTION,
  SORT_KEYS,
  cellStanding,
  comparabilityNotes,
  gridCell,
  sortCandidates,
  verdictRank,
  type SortableCandidate,
} from '../src/domain/candidateComparison.js';

// Comparing candidates is the whole point of this feature, so the rules that
// decide the order — and the ones that refuse to compare two figures that were
// not produced the same way — are tested here on their own, away from Prisma.

function row(over: Partial<SortableCandidate> & { id: string }): SortableCandidate {
  return {
    name: over.id,
    verdict: null,
    score: null,
    stageOrder: null,
    movedAt: 0,
    ...over,
  };
}

const ids = (rows: readonly SortableCandidate[]) => rows.map((r) => r.id);

describe('sort keys', () => {
  it('offers exactly the keys the role page sorts by', () => {
    expect([...SORT_KEYS]).toEqual(['verdict', 'score', 'stage', 'recency', 'name']);
  });

  it('starts a name sort at A and every other sort at the strongest', () => {
    expect(DEFAULT_DIRECTION.name).toBe('asc');
    expect(DEFAULT_DIRECTION.verdict).toBe('desc');
    expect(DEFAULT_DIRECTION.score).toBe('desc');
    expect(DEFAULT_DIRECTION.stage).toBe('desc');
    expect(DEFAULT_DIRECTION.recency).toBe('desc');
  });
});

describe('verdictRank', () => {
  it('ranks proceed above consider above do not progress', () => {
    expect(verdictRank('PROCEED')).toBeGreaterThan(verdictRank('CONSIDER') ?? 0);
  });

  it('ranks consider above do not progress', () => {
    expect(verdictRank('CONSIDER')).toBeGreaterThan(verdictRank('DO_NOT_PROGRESS') ?? 0);
  });

  it('has no rank for a verdict nobody has given', () => {
    expect(verdictRank(null)).toBeNull();
  });

  it('has no rank for a value outside the one vocabulary', () => {
    expect(verdictRank('APPROVED')).toBeNull();
  });
});

describe('sortCandidates', () => {
  it('puts the strongest verdict first when sorting by verdict', () => {
    const rows = [row({ id: 'c', verdict: 'DO_NOT_PROGRESS' }), row({ id: 'a', verdict: 'PROCEED' }), row({ id: 'b', verdict: 'CONSIDER' })];
    expect(ids(sortCandidates(rows, 'verdict', 'desc'))).toEqual(['a', 'b', 'c']);
  });

  it('keeps candidates with no verdict at the foot when sorting best first', () => {
    const rows = [row({ id: 'none' }), row({ id: 'a', verdict: 'PROCEED' })];
    expect(ids(sortCandidates(rows, 'verdict', 'desc'))).toEqual(['a', 'none']);
  });

  it('keeps candidates with no verdict at the foot when the sort is reversed too', () => {
    const rows = [row({ id: 'none' }), row({ id: 'a', verdict: 'PROCEED' })];
    expect(ids(sortCandidates(rows, 'verdict', 'asc'))).toEqual(['a', 'none']);
  });

  it('orders by score, highest first', () => {
    const rows = [row({ id: 'low', score: 41 }), row({ id: 'high', score: 88 })];
    expect(ids(sortCandidates(rows, 'score', 'desc'))).toEqual(['high', 'low']);
  });

  it('treats a zero score as a score, not as a missing one', () => {
    const rows = [row({ id: 'missing' }), row({ id: 'zero', score: 0 })];
    expect(ids(sortCandidates(rows, 'score', 'desc'))).toEqual(['zero', 'missing']);
  });

  it('orders by how far through the pipeline a candidate has reached', () => {
    const rows = [row({ id: 'early', stageOrder: 1 }), row({ id: 'late', stageOrder: 4 })];
    expect(ids(sortCandidates(rows, 'stage', 'desc'))).toEqual(['late', 'early']);
  });

  it('orders by when the application last moved', () => {
    const rows = [row({ id: 'old', movedAt: 1 }), row({ id: 'fresh', movedAt: 99 })];
    expect(ids(sortCandidates(rows, 'recency', 'desc'))).toEqual(['fresh', 'old']);
  });

  it('orders names without regard to case', () => {
    const rows = [row({ id: 'b', name: 'ada' }), row({ id: 'a', name: 'Bob' })];
    expect(ids(sortCandidates(rows, 'name', 'asc'))).toEqual(['b', 'a']);
  });

  it('breaks a tie by name so the same page never comes back in a different order', () => {
    const rows = [row({ id: '2', name: 'Zoe', score: 50 }), row({ id: '1', name: 'Ada', score: 50 })];
    expect(ids(sortCandidates(rows, 'score', 'desc'))).toEqual(['1', '2']);
  });

  it('leaves the rows it was given untouched', () => {
    const rows = [row({ id: 'b', score: 1 }), row({ id: 'a', score: 2 })];
    sortCandidates(rows, 'score', 'desc');
    expect(ids(rows)).toEqual(['b', 'a']);
  });
});

describe('gridCell', () => {
  it('reads a graded competency as its level', () => {
    expect(gridCell({ level: 4, notEnoughEvidence: false })).toEqual({ kind: 'level', level: 4 });
  });

  it('says there is no evidence rather than showing a zero', () => {
    expect(gridCell({ level: null, notEnoughEvidence: true })).toEqual({ kind: 'no_evidence' });
  });

  it('says there is no evidence when grading could not produce a level', () => {
    expect(gridCell({ level: null, notEnoughEvidence: false, gradingUnavailable: true })).toEqual({ kind: 'no_evidence' });
  });

  it('says a competency was never put to this candidate when the assessment has no row for it', () => {
    expect(gridCell(undefined)).toEqual({ kind: 'not_assessed' });
  });

  it('treats a stored level of zero as no evidence, never as a score of nothing', () => {
    expect(gridCell({ level: 0, notEnoughEvidence: false })).toEqual({ kind: 'no_evidence' });
  });
});

describe('cellStanding', () => {
  it('marks a level above what the role asks for', () => {
    expect(cellStanding(5, 3)).toBe('above');
  });

  it('marks a level that meets what the role asks for', () => {
    expect(cellStanding(3, 3)).toBe('meets');
  });

  it('marks a level below what the role asks for', () => {
    expect(cellStanding(2, 3)).toBe('below');
  });

  it('has no standing to give when the role states no required level', () => {
    expect(cellStanding(3, 0)).toBeNull();
  });
});

describe('comparabilityNotes', () => {
  const graded = { competenciesGraded: 6, durationMinutes: 45 };

  it('says nothing when every candidate was assessed the same way', () => {
    const notes = comparabilityNotes([
      { candidateId: 'a', scorecardVersion: 3, ...graded },
      { candidateId: 'b', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('a')).toEqual([]);
    expect(notes.get('b')).toEqual([]);
  });

  it('marks the candidate assessed on an older scorecard', () => {
    const notes = comparabilityNotes([
      { candidateId: 'old', scorecardVersion: 2, ...graded },
      { candidateId: 'new', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('old')?.map((n) => n.kind)).toEqual(['scorecard_version']);
    expect(notes.get('old')?.[0].text).toContain('different scorecard version');
  });

  it('names both versions so the difference is checkable', () => {
    const notes = comparabilityNotes([
      { candidateId: 'old', scorecardVersion: 2, ...graded },
      { candidateId: 'new', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('old')?.[0].text).toContain('v2');
  });

  it('leaves the candidate on the newest scorecard unmarked', () => {
    const notes = comparabilityNotes([
      { candidateId: 'old', scorecardVersion: 2, ...graded },
      { candidateId: 'new', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('new')).toEqual([]);
  });

  it('marks an interview that covered fewer competencies', () => {
    const notes = comparabilityNotes([
      { candidateId: 'thin', scorecardVersion: 3, competenciesGraded: 3, durationMinutes: 45 },
      { candidateId: 'full', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('thin')?.map((n) => n.kind)).toEqual(['interview_depth']);
  });

  it('marks a markedly shorter interview', () => {
    const notes = comparabilityNotes([
      { candidateId: 'short', scorecardVersion: 3, competenciesGraded: 6, durationMinutes: 20 },
      { candidateId: 'full', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('short')?.map((n) => n.kind)).toEqual(['interview_depth']);
  });

  it('does not call a few minutes of difference a different depth', () => {
    const notes = comparabilityNotes([
      { candidateId: 'a', scorecardVersion: 3, competenciesGraded: 6, durationMinutes: 43 },
      { candidateId: 'b', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('a')).toEqual([]);
  });

  it('says nothing about a candidate with no assessment to compare', () => {
    const notes = comparabilityNotes([
      { candidateId: 'none', scorecardVersion: null, competenciesGraded: null, durationMinutes: null },
      { candidateId: 'full', scorecardVersion: 3, ...graded },
    ]);
    expect(notes.get('none')).toEqual([]);
  });

  it('says nothing when only one candidate is being looked at', () => {
    const notes = comparabilityNotes([{ candidateId: 'only', scorecardVersion: 1, competenciesGraded: 2, durationMinutes: 15 }]);
    expect(notes.get('only')).toEqual([]);
  });
});
