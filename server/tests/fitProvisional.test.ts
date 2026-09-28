import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeFitScore } from '../src/engines/fitScoring.js';
import {
  FIT_NEEDS_A_PERSON, FIT_PROVISIONAL_NOTE, comparableFitScore, isProvisionalFit,
} from '../src/domain/fitVocabulary.js';
import { DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, STRONG_CV } from './fixtures/cvFixtures.js';

/**
 * A reading measured against a scorecard nobody approved.
 *
 * `services/scorecards.ts` falls through to the newest DRAFT scorecard when a
 * role has never been approved, so a machine's unchecked first reading of a job
 * description can score real candidates. That is a deliberate trade — it is how
 * a bad draft gets found out — but only if the resulting number is marked, and
 * only if everything that ranks or compares candidates refuses to touch it.
 *
 * These tests hold the mark in place. The rule itself is written at
 * `scorecardForFit`; this is the part of it a machine can check.
 */

const NOW = new Date('2026-09-23T00:00:00Z');
const score = (status?: 'approved' | 'draft') =>
  computeFitScore({}, STRONG_CV, DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, { now: NOW, scorecardVersion: 2, scorecardStatus: status }).fit;

describe('a fit scored against a draft scorecard', () => {
  const draft = score('draft');

  it('says so in a field, not in a docstring', () => {
    expect(draft.scorecardStatus).toBe('draft');
    expect(draft.provisional).toBe(true);
  });

  it('is recognised as provisional by the one predicate every reader uses', () => {
    expect(isProvisionalFit(draft)).toBe(true);
  });

  it('has no number a ranking or a comparison may use', () => {
    expect(comparableFitScore(draft)).toBeNull();
  });

  it('still produces the whole reading, because a draft is checked by looking at it', () => {
    expect(draft.overall).toBeGreaterThan(0);
    expect(draft.competencies!.length).toBeGreaterThan(0);
    expect(draft.probes.length).toBeGreaterThan(0);
  });

  it('scores exactly what the approved reading would, so the flag is a label and not a penalty', () => {
    const approved = score('approved');
    expect(draft.overall).toBe(approved.overall);
    expect(draft.components.map((c) => `${c.key}=${c.score}`)).toEqual(approved.components.map((c) => `${c.key}=${c.score}`));
  });
});

describe('a fit scored against an approved scorecard', () => {
  const approved = score('approved');

  it('is not provisional', () => {
    expect(approved.provisional).toBe(false);
    expect(isProvisionalFit(approved)).toBe(false);
  });

  it('hands its number to a comparison', () => {
    expect(comparableFitScore(approved)).toBe(approved.overall);
  });
});

describe('a stored row written before any of this existed', () => {
  const older = score();

  it('carries neither field, so an old row still parses', () => {
    expect(older.provisional).toBeUndefined();
    expect(older.scorecardStatus).toBeUndefined();
  });

  it('is not treated as provisional, because absent is not the same as yes', () => {
    expect(isProvisionalFit(older)).toBe(false);
    expect(isProvisionalFit(null)).toBe(false);
    expect(isProvisionalFit({})).toBe(false);
  });
});

describe('comparableFitScore', () => {
  it('refuses a reading with no number at all', () => {
    expect(comparableFitScore({ overall: undefined })).toBeNull();
    expect(comparableFitScore(null)).toBeNull();
  });

  it('refuses a provisional reading however high it is', () => {
    expect(comparableFitScore({ overall: 99, provisional: true })).toBeNull();
  });
});

// --- The one write path, and the readers -----------------------------------------

const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
const readWeb = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', 'web', 'src', ...parts), 'utf8');

describe('the path that stores a fit', () => {
  const resumeProfile = read('src', 'services', 'resumeProfile.ts');

  it('asks the scorecard whether a person approved it', () => {
    expect(resumeProfile).toContain('scorecardStatus');
    expect(resumeProfile).toMatch(/scorecard\.status === 'approved'/);
  });

  it('passes that answer into the scorer rather than dropping it', () => {
    expect(resumeProfile).toMatch(/scorecardStatus: o\.scoring\.scorecardStatus/);
  });
});

describe('the decision about what a provisional reading may do', () => {
  const scorecards = read('src', 'services', 'scorecards.ts');

  it('is written down where the fall-through happens', () => {
    expect(scorecards).toContain('may NEVER do');
    expect(scorecards.toLowerCase()).toContain('order, rank or shortlist');
  });
});

describe('the candidates list', () => {
  const list = read('src', 'services', 'candidateList.ts');

  it('never orders by a fit score', () => {
    expect(list).toMatch(/const ORDER[^;]*createdAt: 'desc'/);
    // Not a blanket "fit" search: the row SELECT legitimately names
    // `fitScoreJson` next to an `orderBy` that picks the newest profile row.
    expect(list).not.toMatch(/orderBy[^;]*overall/i);
    expect(list).not.toMatch(/sort\([^)]*fit/i);
  });

  it('says in the code why it does not', () => {
    expect(list).toContain('never by fit');
  });
});

describe('the better-fit comparison', () => {
  const candidates = read('src', 'routes', 'candidates.ts');

  it('takes the number it compares from comparableFitScore, not from the raw field', () => {
    expect(candidates).toMatch(/const currentOverall: number \| null = comparableFitScore\(currentFit\)/);
  });

  it('says plainly when it is refusing to compare a provisional reading', () => {
    expect(candidates).toContain('is provisional and is not compared with anything');
  });

  it('marks the readings it computes itself as approved, because it only reads approved scorecards', () => {
    expect(candidates.match(/scorecardStatus: 'approved'/g)?.length).toBe(2);
  });
});

describe('the browser', () => {
  const vocabulary = readWeb('components', 'fit', 'fitVocabulary.ts');
  const panel = readWeb('components', 'fit', 'FitPanel.tsx');
  const list = readWeb('pages', 'CandidatesList.tsx');

  it('carries the same provisional wording as the engine', () => {
    expect(vocabulary).toContain(FIT_PROVISIONAL_NOTE);
  });

  it('carries the same sentence about a CV that cannot be judged', () => {
    expect(vocabulary).toContain(FIT_NEEDS_A_PERSON);
  });

  it('labels a provisional reading on the fit panel', () => {
    expect(panel).toContain('FIT_PROVISIONAL_NOTE');
    expect(panel).toContain('fit-provisional');
  });

  it('labels a provisional reading in the candidate list too', () => {
    expect(list).toContain('FIT_PROVISIONAL_LABEL');
    expect(list).toContain("c.fit?.provisional === true");
  });

  it('says a CV it cannot judge needs a person, rather than leaving a low number to speak', () => {
    expect(panel).toContain('FIT_NEEDS_A_PERSON');
    expect(FIT_NEEDS_A_PERSON).toContain('needs a person');
  });
});
