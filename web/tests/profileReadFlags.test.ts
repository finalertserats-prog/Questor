import { describe, it, expect } from 'vitest';
import {
  datedLineCoverage, parseChecks, parseFlags, readingIsUsable, readingSummary,
  type ProfileRead, type ReadParseFlag, type ReadRole,
} from '../src/components/profile/profileReadModel';

/**
 * What a recruiter is told about the reading itself.
 *
 * The screen used to say "1 role read from the CV — nothing flagged" about a
 * German CV containing two jobs, with every fact on it marked as read. Every
 * word of that was true and the whole of it was wrong, and there was nowhere
 * on the page for the wrongness to appear. This file is the contract for the
 * place that now exists.
 */

const role = (over: Partial<ReadRole> = {}): ReadRole => ({
  title: 'Senior Data Engineer', employer: 'Northwind', startYear: 2021, endYear: 2026,
  current: true, months: 54, evidence: { line: 0, sourceLine: 5, quote: 'x', section: 'experience' },
  bullets: [], ...over,
});

const flag = (over: Partial<ReadParseFlag> = {}): ReadParseFlag => ({
  code: 'dated_lines_not_read', severity: 'review',
  message: '1 line carries dates that the reading could not use. Check line 9 against the document.',
  sourceLines: [9], ...over,
});

const read = (over: Partial<ProfileRead> = {}): ProfileRead => ({
  roles: [role()], technologies: [], qualifications: [], scope: [], gaps: [],
  tenure: { roleCount: 1, accountedMonths: 54 },
  redaction: { linesRemoved: 0, kinds: [], injectionLines: [] },
  source: 'deterministic', ...over,
});

describe('a reading with nothing to say about itself', () => {
  const assessed = read({ parseQuality: { readable: true, datedLines: 2, datedLinesRead: 2, flags: [] } });

  it('says nothing was flagged, having looked', () => {
    expect(parseFlags(assessed)).toEqual([]);
    expect(readingSummary(assessed)).toBe('1 role read from the CV — nothing flagged.');
  });

  it('treats a profile parsed before the parser could say as unassessed, not as clean', () => {
    // No `parseQuality` at all. "Nothing flagged" would be reassurance about
    // a reading nobody has ever examined, which is the confident silence this
    // signal exists to end — arriving by the back door of a default.
    expect(read().parseQuality).toBeUndefined();
    expect(datedLineCoverage(read())).toBeNull();
    expect(readingSummary(read()))
      .toBe('1 role read from the CV — not checked for gaps — re-analyse the CV to check it.');
  });
});

describe('a reading that missed something', () => {
  const missed = read({ parseQuality: { readable: true, datedLines: 3, datedLinesRead: 2, flags: [flag()] } });

  it('counts the finding in the summary instead of saying nothing was flagged', () => {
    expect(readingSummary(missed)).toBe('1 role read from the CV — 1 to check.');
  });

  it('names the line to open', () => {
    expect(parseFlags(missed)[0].message).toContain('line 9');
    expect(parseFlags(missed)[0].sourceLines).toEqual([9]);
  });

  it('says how much of the document it read', () => {
    expect(datedLineCoverage(missed)).toBe('2 of 3 dated lines read');
  });
});

describe('the order findings are read in', () => {
  const many = read({
    parseQuality: {
      readable: true,
      datedLines: 4,
      datedLinesRead: 3,
      flags: [
        flag({ code: 'headings_not_recognised', severity: 'note', message: 'Headings were not recognised. Check the roles.', sourceLines: [] }),
        flag({ code: 'no_current_role_read', severity: 'review' }),
      ],
    },
  });

  it('puts what needs doing above what is only context', () => {
    expect(parseFlags(many).map((f) => f.code)).toEqual(['no_current_role_read', 'headings_not_recognised']);
  });

  it('counts only the findings that want a person', () => {
    expect(parseChecks(many)).toHaveLength(1);
    expect(readingSummary(many)).toBe('1 role read from the CV — 1 to check.');
  });
});

describe('a document that is not a CV', () => {
  const notACv = read({
    roles: [],
    tenure: { roleCount: 0 },
    parseQuality: {
      readable: false, datedLines: 0, datedLinesRead: 0,
      flags: [{ code: 'not_a_cv', severity: 'blocking', message: 'This file could not be read as a CV. Open it and check.', sourceLines: [] }],
    },
  });

  it('is not presented as a reading at all', () => {
    expect(readingIsUsable(notACv)).toBe(false);
    expect(readingSummary(notACv)).toBe('This document could not be read as a CV. Open the file and check it is the right one.');
  });
});
