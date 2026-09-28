import { describe, expect, it } from 'vitest';
import { extractCvFacts } from '../src/engines/cvFacts.js';
import { totalExperienceYears } from '../src/engines/experienceSpan.js';
import { findDateRanges } from '../src/domain/cvDates.js';
import { CORPUS_TODAY, CV_CORPUS, corpusText } from './fixtures/cv/corpus.js';

/**
 * A CV is written in the language its author works in.
 *
 * The failure this file exists for: a German data engineer's current job runs
 * "01.03.2021 – heute". `heute` was not in the vocabulary, so the range did
 * not parse; the line was therefore not a role heading; the role vanished; the
 * bullets under it were attached to nothing; and eight years of career were
 * reported as "1 role" and "3 yr 7 mo" — on the figure that decides how hard
 * the interview they sit is pitched, and with nothing anywhere saying a word
 * had been missed.
 *
 * The same hole was open for French, Spanish, Portuguese, Italian and Dutch,
 * and for every month name outside English.
 */

const factsFor = (id: string) => {
  const fixture = CV_CORPUS.find((c) => c.id === id);
  if (!fixture) throw new Error(`No fixture ${id}`);
  return extractCvFacts(corpusText(fixture), { today: CORPUS_TODAY });
};

const textFor = (id: string) => {
  const fixture = CV_CORPUS.find((c) => c.id === id);
  if (!fixture) throw new Error(`No fixture ${id}`);
  return corpusText(fixture);
};

describe('a German CV', () => {
  it('reads both dated roles, not one', () => {
    expect(factsFor('de-heute').roles).toHaveLength(2);
  });

  it('reads the job running "heute" as the current one', () => {
    const current = factsFor('de-heute').roles.filter((r) => r.current);
    expect(current.map((r) => r.title)).toEqual(['Senior Data Engineer']);
  });

  it('accounts for the whole career, not the half it could date', () => {
    // 3 yr 7 mo was what the candidate's profile said. She has worked since
    // August 2017.
    const { tenure } = factsFor('de-heute');
    expect(tenure.accountedMonths).toBeGreaterThanOrEqual(106);
  });

  it('reports the years of experience the document supports', () => {
    expect(totalExperienceYears(textFor('de-heute'), CORPUS_TODAY)).toBe(9);
  });

  it('reads a German CV whose months are written out in full', () => {
    const roles = factsFor('de-prose-no-tech').roles;
    expect(roles.map((r) => [r.startYear, r.endYear, r.current]))
      .toEqual([[2019, 2026, true], [2014, 2018, false]]);
  });
});

describe('a French CV', () => {
  it("reads the job running \"aujourd'hui\" as the current one", () => {
    const roles = factsFor('fr-aujourdhui').roles;
    expect(roles).toHaveLength(2);
    expect(roles.filter((r) => r.current)).toHaveLength(1);
  });

  it('reads French month names', () => {
    expect(findDateRanges('Janvier 2017 – août 2020')[0]).toMatchObject({
      start: { year: 2017, month: 1 },
      end: { year: 2020, month: 8 },
    });
  });

  it('does not confuse juin with juillet', () => {
    expect(findDateRanges('juin 2019 - juillet 2021')[0]).toMatchObject({
      start: { year: 2019, month: 6 },
      end: { year: 2021, month: 7 },
    });
  });
});

describe('a Spanish CV', () => {
  it('reads the job running "actualidad" as the current one', () => {
    const roles = factsFor('es-actualidad').roles;
    expect(roles).toHaveLength(2);
    expect(roles.filter((r) => r.current)).toHaveLength(1);
  });

  it('reads the years of experience the document supports', () => {
    expect(totalExperienceYears(textFor('es-actualidad'), CORPUS_TODAY)).toBe(7);
  });
});

describe('the two date readers agree', () => {
  /**
   * `parseDateRange` (roles) and `experienceRanges` (years of experience) were
   * separate regexes with separate vocabularies, and a test recorded the
   * disagreement rather than fixing it: a timeline strip reading "2017 - 18"
   * added to the years total while producing no role, so the profile showed
   * experience it could not account for.
   */
  it('both read a two-digit end year', () => {
    const cv = 'EXPERIENCE\nAnalyst, Orbit Retail  2017 - 18\nRan the weekly reporting pack.\n';
    const role = extractCvFacts(cv, { today: CORPUS_TODAY }).roles[0];
    expect([role?.startYear, role?.endYear]).toEqual([2017, 2018]);
    expect(totalExperienceYears(cv, CORPUS_TODAY)).toBeGreaterThan(0);
  });

  it('both read a German ongoing role', () => {
    const cv = 'Berufserfahrung\nData Engineer, Nordwind  01.03.2021 – heute\nDatenpipelines gebaut.\n';
    expect(extractCvFacts(cv, { today: CORPUS_TODAY }).roles[0]?.current).toBe(true);
    expect(totalExperienceYears(cv, CORPUS_TODAY)).toBe(5);
  });
});

describe('the edges a review found in the shared grammar', () => {
  it('reads the Italian abbreviation for September', () => {
    // `sett.` was in the stem table and missing from the pattern, so the range
    // parsed with its start month silently dropped.
    expect(findDateRanges('Progetto sett. 2020 - ott. 2021')[0]).toMatchObject({
      start: { year: 2020, month: 9 },
      end: { year: 2021, month: 10 },
    });
  });

  it('does not turn a backwards two-digit end into a ninety-nine-year job', () => {
    // "1998 - 02" is 2002 and must roll a century. "2019 - 18" is a typo, and
    // rolling it gave 2118 — clamped to today by the years reader, so a job
    // that ended became one still running.
    expect(findDateRanges('Engineer, Acme 1998 - 02')[0]?.end).toMatchObject({ year: 2002 });
    const typo = findDateRanges('Analyst, Orbit 2019 - 18')[0];
    expect(typo?.end?.year).toBeLessThan(2100);
    expect(totalExperienceYears('EXPERIENCE\nAnalyst, Orbit 2019 - 18\n', CORPUS_TODAY)).toBeUndefined();
  });

  it('does not take a year out of the middle of a longer number', () => {
    // A CV is full of numbers that are not dates. "Invoice 992019 - 2022 paid"
    // was three years of employment.
    expect(findDateRanges('Invoice 992019 - 2022 paid')).toEqual([]);
    expect(findDateRanges('Order 12021 - 2022')).toEqual([]);
  });

  it('does not read the English word "actual" as "still working there"', () => {
    // A finance CV writes "Budget 2019 - actual vs forecast" without meaning
    // anything about employment. Spanish says actualmente or actualidad here.
    expect(findDateRanges('Budget 2019 - actual vs forecast')).toEqual([]);
    expect(findDateRanges('Analista, Banco 2019 - actualidad')[0]?.ongoing).toBe(true);
  });

  it('still reads "to date", which spends its preposition on the dash', () => {
    expect(findDateRanges('Consultant, Acme 2019 to date')[0]?.ongoing).toBe(true);
  });
});

describe('a declared career break is not experience', () => {
  it('does not count the break between two dated jobs', () => {
    // The module's own contract: "It counted the gaps." A break the candidate
    // wrote down, with dates on it, was being added to their years of
    // experience because it is a dated range like any other.
    expect(totalExperienceYears(textFor('en-real-gap'), CORPUS_TODAY)).toBeLessThanOrEqual(12);
  });
});
