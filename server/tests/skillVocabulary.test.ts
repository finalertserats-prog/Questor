import { describe, expect, it } from 'vitest';
import { SKILL_VOCABULARY, matchSkills } from '../src/engines/skillVocabulary.js';

/**
 * Which skills a document names.
 *
 * The defect: a thirty-six entry list of engineering tools matched with
 * `includes()`. A senior marketing manager's CV came back as
 * ["Salesforce", "Go"] — one real skill, and one that was the word "Google".
 * Those two lines are shown to the hiring team beside her name.
 */

describe('a substring is not a skill', () => {
  it('does not find Go inside Google', () => {
    expect(matchSkills('Ran campaigns on Google and Googled the rest.')).not.toContain('Go');
  });

  it('does not find Go inside go-to-market', () => {
    expect(matchSkills('Led go-to-market for two products.')).not.toContain('Go');
  });

  it('does find Go where someone actually wrote it', () => {
    expect(matchSkills('Services in Go and Rust.')).toContain('Go');
  });

  it('does not find Java inside JavaScript', () => {
    expect(matchSkills('Frontend in JavaScript.')).not.toContain('Java');
  });

  it('does not find C# in "net-new pipeline"', () => {
    // The alias ".net" once compiled to an optional separator plus "net", so a
    // marketer who influenced $21M+ in net-new pipeline was credited with C#.
    expect(matchSkills('Influenced $21M+ in net-new B2B pipeline.')).not.toContain('C#');
  });

  it('still finds .NET where it is named', () => {
    expect(matchSkills('Services built on .NET and Azure.')).toContain('C#');
  });

  it('does not take a lone capital R for the language', () => {
    expect(matchSkills('Reported to J. R. Patel in Region R.')).not.toContain('R');
  });

  it('finds R where the CV says which R it means', () => {
    expect(matchSkills('Modelling in RStudio and Python.')).toContain('R');
  });
});

describe('covering more than one profession', () => {
  it('reads a marketing CV as a marketer', () => {
    const cv = 'Managed outbound email campaigns via Eloqua, built dashboards in '
      + 'Google Analytics, ran A/B testing on subject lines, and owned demand '
      + 'generation across ABM and paid media.';
    const skills = matchSkills(cv);
    for (const expected of ['Eloqua', 'Google Analytics', 'A/B Testing', 'Demand Generation', 'ABM']) {
      expect(skills, expected).toContain(expected);
    }
  });

  it('reads a finance CV as an accountant', () => {
    const skills = matchSkills('Prepared IFRS financial reporting, ran the audit, owned FP&A in NetSuite.');
    for (const expected of ['IFRS', 'Financial Reporting', 'Audit', 'Forecasting & Planning', 'NetSuite']) {
      expect(skills, expected).toContain(expected);
    }
  });

  it('reads an HR CV as a recruiter', () => {
    const skills = matchSkills('Owned talent acquisition and onboarding in Workday, ran L&D.');
    for (const expected of ['Recruitment', 'Onboarding', 'Workday', 'Learning & Development']) {
      expect(skills, expected).toContain(expected);
    }
  });
});

describe('one skill, one name', () => {
  it('shows every spelling of a skill under a single canonical name', () => {
    expect(matchSkills('Reporting in GA4, Google Analytics 4 and google analytics.')).toEqual(['Google Analytics']);
  });

  it('prefers the longer name where two overlap', () => {
    expect(matchSkills('Ran LinkedIn Ads all quarter.')).toContain('LinkedIn Ads');
  });

  it('lists skills in vocabulary order, so the same CV always reads the same', () => {
    const once = matchSkills('Python, SQL, Salesforce and SEO.');
    expect(matchSkills('SEO, Salesforce, SQL and Python.')).toEqual(once);
  });

  it('says nothing about a document that names no skill it knows', () => {
    expect(matchSkills('A quiet week in the garden.')).toEqual([]);
  });

  it('honours the limit', () => {
    expect(matchSkills('Python SQL Java React AWS Azure Docker', 3)).toHaveLength(3);
  });
});

describe('the vocabulary itself', () => {
  it('names every skill exactly once', () => {
    const names = SKILL_VOCABULARY.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps every alias lower case, because that is what the matcher assumes', () => {
    for (const entry of SKILL_VOCABULARY) {
      for (const alias of entry.aliases ?? []) {
        expect(alias, `${entry.name} -> ${alias}`).toBe(alias.toLowerCase());
      }
    }
  });
});
