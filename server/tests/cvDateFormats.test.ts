import { describe, it, expect } from 'vitest';
import { extractCvFacts } from '../src/engines/cvFacts.js';
import { totalExperienceYears } from '../src/engines/experienceSpan.js';

/**
 * Dates a CV was actually written with.
 *
 * The end of a range was read as `(YEAR|\d{2})`, and a day-first date offers
 * `30` before it ever offers `2021`. So `01.03.2019 - 30.06.2021` read as
 * 2019 to "30" — two digits, same century, 2030 — clamped to today. A role that
 * ended in June 2021 was counted as still running, and the candidate gained
 * five years they had not lived.
 *
 * `01/2015 - 12/2018` failed the other way: end "12" became 2012, which is
 * before the start, so the range was rejected and the whole job disappeared
 * from the CV.
 *
 * Neither is a rare shape. Day-first is how most of Europe and India write a
 * date, and `mm/yyyy` is what every CV builder emits. `totalYears` is printed
 * on the candidate's profile and feeds the band calibration that decides how
 * hard their interview is pitched, so both errors change the interview a real
 * person sits.
 */

const cv = (line: string) => [
  'EXPERIENCE',
  line,
  'Built and ran the data platform.',
].join('\n');

const roleFrom = (line: string) => extractCvFacts(cv(line), { today: new Date('2026-09-27T00:00:00Z') }).roles[0];

describe('a day-first range', () => {
  it('ends in the year the CV says, not the day of the month', () => {
    const role = roleFrom('Senior Analyst, Infosys Ltd.  01.03.2019 - 30.06.2021');
    expect([role?.startYear, role?.endYear]).toEqual([2019, 2021]);
  });

  it('is not left running to today', () => {
    // "30" became 2030 and was clamped to now, so a finished job read as the
    // candidate's current one.
    expect(roleFrom('Senior Analyst, Infosys Ltd.  01.03.2019 - 30.06.2021')?.current).toBe(false);
  });

  it('reads the same range written with slashes', () => {
    const role = roleFrom('Senior Analyst, Infosys Ltd.  01/03/2019 - 30/06/2021');
    expect([role?.startYear, role?.endYear]).toEqual([2019, 2021]);
  });

  it('reads the same range written with dashes inside the dates', () => {
    const role = roleFrom('Senior Analyst, Infosys  01-03-2019 to 30-06-2021');
    expect([role?.startYear, role?.endYear]).toEqual([2019, 2021]);
  });
});

describe('a month-and-year range', () => {
  it('keeps the job instead of dropping it', () => {
    // End "12" read as 2012, which is before the start, so the range was
    // rejected and the role vanished from the candidate's history entirely.
    const role = roleFrom('Data Engineer, Calder Analytics  01/2015 - 12/2018');
    expect([role?.startYear, role?.endYear]).toEqual([2015, 2018]);
  });

  it('reads it with dots too', () => {
    const role = roleFrom('Data Engineer, Calder  03.2015 - 11.2018');
    expect([role?.startYear, role?.endYear]).toEqual([2015, 2018]);
  });
});

describe('the shapes that already worked keep working', () => {
  it('reads a plain year range', () => {
    const role = roleFrom('Analyst, Orbit Retail  2016 - 2019');
    expect([role?.startYear, role?.endYear]).toEqual([2016, 2019]);
  });

  it('reads a two-digit end on a timeline strip in the years total', () => {
    // A gap recorded rather than papered over: the span reader behind
    // `totalYears` understands "2017 - 18", and the role reader does not, so a
    // timeline strip contributes to the total without becoming a listed role.
    // Two date parsers, two vocabularies. Worth unifying; not this change.
    expect(totalExperienceYears(cv('Analyst, Orbit Retail  2017 - 18'))).toBeGreaterThan(0);
  });

  it('reads month words', () => {
    const role = roleFrom('Engineer, Northwind  Jul 2019 - Oct 2020');
    expect([role?.startYear, role?.endYear]).toEqual([2019, 2020]);
  });

  it('still reads a role that is genuinely ongoing', () => {
    const role = roleFrom('Senior Data Engineer, Northwind  March 2021 - Present');
    expect([role?.startYear, role?.current]).toEqual([2021, true]);
  });

  it('does not read a phone number as a date range', () => {
    // The guard that exists because "2018 - 2021" inside a phone number was
    // being read as employment.
    const facts = extractCvFacts(['EXPERIENCE', 'Reach me on +91 98765 43210 for details.'].join('\n'));
    expect(facts.roles).toEqual([]);
  });
});

describe('the years total behind the profile and the band calibration', () => {
  const years = (line: string) => totalExperienceYears(cv(line), new Date('2026-09-27T00:00:00Z'));

  it('does not add five phantom years to a day-first range', () => {
    // "30.06.2021" read its end as "30" → 2030 → clamped to today, so a job
    // that ended in 2021 counted as running for five more years.
    expect(years('Senior Analyst, Infosys Ltd.  01.03.2019 - 30.06.2021')).toBeLessThanOrEqual(3);
  });

  it('does not run a month-and-year range to the present either', () => {
    // The same defect, on the shape every CV builder emits. The audit named
    // the day-first case; this one was inflating just as quietly.
    expect(years('Data Engineer, Calder Analytics  01/2015 - 12/2018')).toBeLessThanOrEqual(4);
  });

  it('still counts a genuinely ongoing role up to today', () => {
    expect(years('Senior Data Engineer, Northwind  March 2021 - Present')).toBeGreaterThanOrEqual(5);
  });
});
