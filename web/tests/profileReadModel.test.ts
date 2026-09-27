import { describe, it, expect } from 'vitest';
import {
  documentLine, monthsInWords, profileTabs, readingSummary, redactionWords, roleConcern, roleDates,
  roleState, sourceLabel, technologyIsListedOnly, technologyNote, technologyState,
  type ProfileRead, type ReadRole, type ReadTechnology,
} from '../src/components/profile/profileReadModel';

/**
 * Lane 1's judgements, away from React.
 *
 * The screen's whole promise is that a recruiter checks a parsed fact in a
 * second instead of re-reading the CV. That rests on two things being true:
 * the line number points at the right line, and the screen admits when it is
 * unsure rather than presenting a guess as a reading.
 */

const CV = [
  'Meera Iyer',                                     // 1
  'meera@example.com',                              // 2
  '',                                               // 3
  'EXPERIENCE',                                     // 4
  'Senior Data Engineer, Northwind (2021 - Present)', // 5
  'Rebuilt the nightly ETL on Airflow.',            // 6
].join('\n');

const evidence = (sourceLine: number | undefined, section = 'experience', quote = 'x') =>
  ({ line: 0, sourceLine, quote, section });

const role = (over: Partial<ReadRole> = {}): ReadRole => ({
  title: 'Senior Data Engineer', employer: 'Northwind', startYear: 2021, current: true,
  months: 54, evidence: evidence(5), bullets: [], ...over,
});

const tech = (over: Partial<ReadTechnology> = {}): ReadTechnology => ({
  name: 'Airflow', firstYear: 2021, lastYear: 2025, evidence: [evidence(6)], ...over,
});

const read = (over: Partial<ProfileRead> = {}): ProfileRead => ({
  roles: [role()], technologies: [tech()], qualifications: [], scope: [], gaps: [],
  tenure: { roleCount: 1 },
  redaction: { linesRemoved: 2, kinds: ['name', 'contact'], injectionLines: [] },
  source: 'deterministic',
  ...over,
});

describe('opening the CV at the line a fact came from', () => {
  it('returns exactly the line the document has there', () => {
    expect(documentLine(CV, 5)).toBe('Senior Data Engineer, Northwind (2021 - Present)');
  });

  it('counts blank lines, because the document does', () => {
    // Line 4 is the heading only if the blank line above it was counted. This
    // is the whole defect the source line exists to fix.
    expect(documentLine(CV, 4)).toBe('EXPERIENCE');
  });

  it('gives nothing rather than a guess when the line was never recorded', () => {
    expect(documentLine(CV, undefined)).toBeNull();
  });

  it('gives nothing when the line is past the end of the document', () => {
    expect(documentLine(CV, 99)).toBeNull();
  });

  it('handles a CV that arrived with Windows line endings', () => {
    expect(documentLine(CV.replace(/\n/g, '\r\n'), 5)).toBe('Senior Data Engineer, Northwind (2021 - Present)');
  });
});

describe('what the screen says about a role', () => {
  it('reads cleanly when it has a line and dates', () => {
    expect(roleState(role())).toBe('read');
  });

  it('asks for a second look when the end date could not be read', () => {
    const open = role({ current: false, endYear: undefined });
    expect([roleState(open), roleConcern(open)])
      .toEqual(['check', 'No end date could be read. Confirm it before tenure is relied on.']);
  });

  it('admits it cannot place a fact from an older profile', () => {
    expect(roleState(role({ evidence: evidence(undefined) }))).toBe('unplaceable');
  });

  it('never invents an end date it did not read', () => {
    expect(roleDates(role({ current: false, endYear: undefined }))).toBe('2021 — ?');
  });

  it('says so plainly when no dates were read at all', () => {
    expect(roleDates(role({ startYear: undefined }))).toBe('Dates not read');
  });

  it('writes a duration a person reads rather than a month count', () => {
    expect([monthsInWords(54), monthsInWords(12), monthsInWords(7), monthsInWords(undefined)])
      .toEqual(['4 yr 6 mo', '1 yr', '7 mo', null]);
  });
});

describe('a technology named but never shown', () => {
  it('separates a skills-list claim from experience in a role', () => {
    const listed = tech({ evidence: [evidence(20, 'skills')] });
    expect([technologyIsListedOnly(listed), technologyState(listed)]).toEqual([true, 'check']);
  });

  it('treats a mention inside a role as evidence of use', () => {
    expect([technologyIsListedOnly(tech()), technologyState(tech())]).toEqual([false, 'read']);
  });

  it('says why a listed-only technology is flagged', () => {
    expect(technologyNote(tech({ evidence: [evidence(20, 'skills')] })))
      .toBe('Named in a skills list, not in any role described.');
  });

  it('counts a technology with no evidence at all as listed only', () => {
    // Not as evidenced. An empty array satisfies `every` vacuously, and reading
    // that as "every mention is in a role" would promote a claim to a finding.
    expect(technologyIsListedOnly(tech({ evidence: [] }))).toBe(true);
  });
});

describe('the summary and the tabs', () => {
  it('counts what needs a human eye, per tab', () => {
    const r = read({ roles: [role(), role({ current: false, endYear: undefined })] });
    const experience = profileTabs(r).find((t) => t.key === 'experience');
    expect([experience?.count, experience?.needsCheck]).toEqual([2, 1]);
  });

  it('counts an injection attempt as something to look at', () => {
    const r = read({ redaction: { linesRemoved: 2, kinds: ['name'], injectionLines: [30] } });
    const notRead = profileTabs(r).find((t) => t.key === 'not-read');
    expect([notRead?.count, notRead?.needsCheck]).toEqual([3, 1]);
  });

  it('leads with what was read and what to check, never with a score', () => {
    const summary = readingSummary(read({ roles: [role(), role({ current: false, endYear: undefined })] }));
    expect(summary).toBe('2 roles read from the CV — 1 to check.');
  });

  it('says plainly when nothing could be read as work history', () => {
    expect(readingSummary(read({ roles: [] })))
      .toBe('Nothing could be read from this CV as work history. read from the CV.');
  });

  it('discloses when a model refined the reading', () => {
    expect(readingSummary(read({ source: 'model_assisted' })))
      .toContain('refined by a model');
  });

  it('never puts a number on the screen that a person cannot act on', () => {
    // No percentage, no confidence, no score anywhere in the summary.
    expect(readingSummary(read())).not.toMatch(/\d+\s*%|score|confidence/i);
  });
});

describe('what was taken out', () => {
  it('names each kind in words a person reads', () => {
    expect(redactionWords(['name', 'contact', 'education_provenance']))
      .toEqual(['a name', 'contact details', 'an institution or graduation year']);
  });

  it('falls back to the raw kind rather than dropping one it does not know', () => {
    expect(redactionWords(['some_new_kind'])).toEqual(['some new kind']);
  });
});

describe('where a fact came from', () => {
  it('names the line when it has one', () => {
    expect(sourceLabel({ sourceLine: 14 })).toBe('line 14');
  });

  it('says it was not recorded rather than naming a line it does not have', () => {
    expect(sourceLabel({ sourceLine: undefined })).toBe('source not recorded');
  });
});
