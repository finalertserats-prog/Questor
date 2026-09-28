import { describe, expect, it } from 'vitest';
import { experienceRanges, mergeRanges, proseOnly, totalExperienceYears } from '../src/engines/experienceSpan.js';

/**
 * Years of experience, from the date ranges a CV writes down.
 *
 * Every case here is a real CV or a real failure. The first one is the defect
 * that started this: a senior marketing manager's profile said "31 yrs
 * experience" because her email address is kvishwkarma1995@gmail.com and the
 * parser took every four-digit number in the document as a year.
 */

// Fixed, so "Present" means something a test can assert.
const NOW = new Date('2026-09-24T00:00:00Z');

describe('what is not a date', () => {
  it('does not read the year out of an email address', () => {
    const cv = 'Kajal Joshi\nkvishwkarma1995@gmail.com\n\nExperience\nMarketing Manager, Acme (2013 - Present)\n';
    expect(totalExperienceYears(cv, NOW)).toBe(13);
  });

  it('leaves a plain date range alone while masking a phone number', () => {
    const masked = proseOnly('Call +91 8368566722. Engineer, Acme 2018 - 2021.');
    expect(masked).toContain('2018 - 2021');
    expect(masked).not.toContain('8368566722');
  });

  it('keeps a career timeline strip, which is nothing but digits and dashes', () => {
    // pdf-parse renders these side by side; masking them as one phone number
    // deleted the candidate's whole history.
    expect(proseOnly('2017 - 18   2021 - 22   2022 - 25')).toBe('2017 - 18   2021 - 22   2022 - 25');
  });

  it('does not count a product version as a year', () => {
    const cv = 'Skills\nSQL Server 2012 - 2016, Windows Server 2019, Office 365, ISO 9001\n';
    expect(totalExperienceYears(cv, NOW)).toBeUndefined();
  });

  it('needs a range, not a lone year', () => {
    expect(totalExperienceYears('Education\nB.Sc. Computer Science, 2014\n', NOW)).toBeUndefined();
  });

  it('ignores a URL that carries a year', () => {
    expect(totalExperienceYears('portfolio at example.com/2011/best-of-2019\n', NOW)).toBeUndefined();
  });
});

describe('reading a range', () => {
  it('reads month and year at both ends', () => {
    const [r] = experienceRanges('Marketing Manager, Recur Club. August 2025 - June 2026', NOW);
    expect([r.startMonth, r.endMonth]).toEqual([2025 * 12 + 7, 2026 * 12 + 5]);
  });

  it('reads a year-only range as whole years', () => {
    // "2021 - 2024" is three years of work, not two: the role ran through 2024.
    expect(totalExperienceYears('Engineer, Acme 2021 - 2024', NOW)).toBe(4);
  });

  it('reads the two-digit end a timeline strip uses', () => {
    const [r] = experienceRanges('2017 - 18', NOW);
    expect(r.endMonth).toBe(2018 * 12 + 11);
  });

  it('runs an ongoing role up to today', () => {
    const [r] = experienceRanges('Director, Acme 2004 - Present', NOW);
    expect([r.ongoing, r.endMonth]).toEqual([true, 2026 * 12 + 8]);
  });

  it('accepts the other ways a CV says it has not ended', () => {
    for (const word of ['Present', 'current', 'now', 'to date', 'till date', 'Ongoing']) {
      expect(experienceRanges(`Engineer, Acme 2015 - ${word}`, NOW)[0]?.ongoing, word).toBe(true);
    }
  });

  it('refuses a range that ends before it starts', () => {
    expect(experienceRanges('Engineer 2021 - 2018', NOW)).toEqual([]);
  });

  it('does not credit months that have not happened yet', () => {
    const [r] = experienceRanges('Engineer, Acme 2024 - 2030', NOW);
    expect(r.endMonth).toBe(2026 * 12 + 8);
  });
});

describe('adding the ranges up', () => {
  it('counts an overlap once', () => {
    // A promotion written as two entries is one continuous career, not two.
    const cv = 'Senior Engineer, Acme 2020 - 2024\nEngineer, Acme 2018 - 2020\n';
    expect(totalExperienceYears(cv, NOW)).toBe(7);
  });

  it('joins two roles that meet, because changing job is not a break', () => {
    const merged = mergeRanges([
      { startMonth: 2018 * 12, endMonth: 2020 * 12 + 5, ongoing: false },
      { startMonth: 2020 * 12 + 6, endMonth: 2022 * 12, ongoing: false },
    ]);
    expect(merged).toHaveLength(1);
  });

  it('does not count a career break as experience', () => {
    // Worked 2010-2012, away eight years, back in 2020. Four years, not twelve.
    const cv = 'Analyst, Acme 2010 - 2012\nAnalyst, Beta 2020 - 2022\n';
    expect(totalExperienceYears(cv, NOW)).toBe(6);
  });

  it('truncates rather than rounds up', () => {
    // 2004-01 to 2026-09 is twenty-two years and nine months. Nobody calls
    // that twenty-three, least of all on the figure that decides the level
    // they are interviewed at.
    expect(totalExperienceYears('Director, Acme 2004 - Present', NOW)).toBe(22);
  });

  it('never reports zero for someone who has worked', () => {
    expect(totalExperienceYears('Intern, Acme Jan 2026 - Mar 2026', NOW)).toBe(1);
  });

  it('stays under the ceiling however old the CV is', () => {
    expect(totalExperienceYears('Engineer, Acme 1960 - Present', NOW)).toBeLessThanOrEqual(45);
  });
});

describe('what an adversarial CV cannot do', () => {
  /**
   * A CV is a file a stranger uploads. Every pattern here can backtrack, and
   * before the scan was chunked, 200,000 characters of "1" — the extraction
   * cap, on one line — held a CPU core for 78 seconds, and 200,000 dashes for
   * 75. One file at a time, against a public upload endpoint.
   */
  it('reads a CV of nothing but digits in well under a second', () => {
    const started = Date.now();
    expect(totalExperienceYears('1'.repeat(200_000), NOW)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reads a CV of nothing but dashes in well under a second', () => {
    const started = Date.now();
    expect(totalExperienceYears('-'.repeat(200_000), NOW)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('masks a document of digits without stalling', () => {
    const started = Date.now();
    proseOnly('9'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('the edges Codex found', () => {
  it('reads a two-digit end year across a century', () => {
    // "1998 - 02" is 2002. Taking the start's century made it 1902, which
    // ends before it starts, so the role was thrown away and the candidate
    // lost four years.
    expect(totalExperienceYears('Engineer, Acme 1998 - 02', NOW)).toBe(5);
  });

  it('does not take "presently" for "present"', () => {
    // No trailing boundary meant "2019 - presently reviewing" read as a role
    // still running today.
    expect(experienceRanges('Engineer, Acme 2019 - 2020. Presently reviewing offers.', NOW)[0].ongoing).toBe(false);
  });

  it('does not take "dates" or "dated" for "to date"', () => {
    expect(experienceRanges('Engineer, Acme 2019 - dates vary', NOW)).toEqual([]);
  });

  it('does not take "nowhere" for "now"', () => {
    expect(experienceRanges('Engineer, Acme 2019 - nowhere near done', NOW)).toEqual([]);
  });
});
