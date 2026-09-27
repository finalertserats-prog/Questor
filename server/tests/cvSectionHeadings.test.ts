import { describe, it, expect } from 'vitest';
import { extractCvFacts } from '../src/engines/cvFacts.js';
import { prepareCvForScoring } from '../src/engines/cvRedaction.js';

/**
 * The word a candidate chose for a heading decided whether they had a career.
 *
 * `cvRedaction.SECTION_PATTERNS` is what files each line under a section, and
 * it was narrower than `resumeParser.SECTION_HEADINGS` — no "relevant
 * experience", no "positions held", no "career", no "roles", and nothing that
 * is not English. A heading it does not recognise leaves `section` as
 * `summary` for the whole document, `isRoleHeading` then returns false on
 * every line, and the CV yields ZERO roles.
 *
 * What that costs the candidate, all of it automatic: no roles means no
 * technology dates, so every technology falls to `recencyYears: null` and
 * scores 55 instead of 95, and confidence is docked a further 0.15. They are
 * marked down for writing "Berufserfahrung" instead of "Experience".
 *
 * Two vocabularies for one idea, in two files, is the defect underneath the
 * defect — so there is now one list and both read it.
 */

const cvWith = (heading: string) => [
  heading,
  'Senior Data Engineer, Northwind Logistics (March 2021 - Present)',
  'Rebuilt the nightly ETL on Airflow and ran the platform.',
].join('\n');

const rolesUnder = (heading: string) => extractCvFacts(cvWith(heading)).roles;
const sectionOf = (heading: string) => {
  const cv = prepareCvForScoring(cvWith(heading));
  return cv.lines.find((l) => l.text.startsWith('Senior Data Engineer'))?.section;
};

describe('English headings a CV really uses', () => {
  const HEADINGS = [
    'EXPERIENCE',
    'Work Experience',
    'Relevant Experience',
    'Professional History',
    'Positions Held',
    'Career',
    'Career History',
    'Roles',
    'Appointments',
    'Employment History',
  ];

  it.each(HEADINGS)('files what follows %s as experience', (heading) => {
    expect(sectionOf(heading)).toBe('experience');
  });

  it.each(HEADINGS)('reads a role under %s', (heading) => {
    expect(rolesUnder(heading)).toHaveLength(1);
  });
});

describe('headings that are not in English', () => {
  // A CV is written in the language its author works in. Refusing to read one
  // is not a parser limitation the candidate should pay for.
  const HEADINGS: ReadonlyArray<[string, string]> = [
    ['German', 'Berufserfahrung'],
    ['French', 'Parcours professionnel'],
    ['French, short', 'Expérience professionnelle'],
    ['Spanish', 'Experiencia profesional'],
    ['Portuguese', 'Experiência profissional'],
    ['Italian', 'Esperienza lavorativa'],
    ['Dutch', 'Werkervaring'],
  ];

  it.each(HEADINGS)('files what follows a %s heading as experience', (_language, heading) => {
    expect(sectionOf(heading)).toBe('experience');
  });
});

describe('education headings that are not in English', () => {
  // The other direction, and it costs the candidate the opposite way: an
  // education section read as employment counts a degree as a job, so a 2024
  // graduate with two years of work reads as six.
  const HEADINGS = ['Ausbildung', 'Formation', 'Formación', 'Educação', 'Studium', 'Opleiding'];

  it.each(HEADINGS)('files what follows %s as education, not experience', (heading) => {
    const cv = prepareCvForScoring([heading, 'B.Tech Computer Science, Anna University, 2016'].join('\n'));
    expect(cv.lines.find((l) => l.text.includes('Computer Science'))?.section).toBe('education');
  });
});

describe('the two heading vocabularies agree', () => {
  it('files everything the resume parser calls an experience heading as experience', async () => {
    // Imported from the parser rather than copied, so a heading added to one
    // list and forgotten in the other fails here. That divergence is what
    // caused this defect: one file knew "positions held" and the other did not.
    const { SECTION_HEADINGS } = await import('../src/engines/resumeParser.js');
    // Two headings contain a work word and deliberately are NOT experience.
    // Unpaid work is not employment, and a list of courses taken is not a job;
    // filing either as experience inflates a career. Named here rather than
    // filtered by pattern, so that adding a third exception has to be a
    // decision somebody makes on purpose.
    const DELIBERATELY_ELSEWHERE = new Set(['volunteer experience', 'coursework']);
    const experienceWords = [...SECTION_HEADINGS]
      .filter((h) => /experience|employment|career|positions|appointments|roles|work|professional history/.test(h))
      .filter((h) => !DELIBERATELY_ELSEWHERE.has(h));

    const misfiled = experienceWords.filter((h) => sectionOf(h) !== 'experience');

    expect(misfiled).toEqual([]);
  });
});

describe('a heading is still a heading and not a sentence', () => {
  it('does not read a line about experience as a section heading', () => {
    // The guard that keeps "I have eight years of experience building data
    // platforms for regulated clients" from resetting the section.
    const cv = prepareCvForScoring([
      'EXPERIENCE',
      'Senior Data Engineer, Northwind Logistics (March 2021 - Present)',
      'I have eight years of experience building data platforms for regulated clients.',
      'Ran the nightly ETL.',
    ].join('\n'));
    const sections = cv.lines.filter((l) => l.text.startsWith('I have eight') || l.text.startsWith('Ran the nightly'));
    expect(sections.map((l) => l.section)).toEqual(['experience', 'experience']);
  });
});

describe('the back of the CV stays at the back', () => {
  it('does not count unpaid work as employment', () => {
    const cv = prepareCvForScoring(['Volunteer Experience', 'Trustee, Local Food Bank (2019 - 2021)'].join('\n'));
    expect(cv.lines.find((l) => l.text.startsWith('Trustee'))?.section).toBe('other');
  });

  it('does not count a list of courses as jobs', () => {
    const cv = prepareCvForScoring(['Coursework', 'Distributed Systems, 2016'].join('\n'));
    expect(cv.lines.find((l) => l.text.startsWith('Distributed'))?.section).toBe('other');
  });

  it('does not read a bibliography as a career', () => {
    // An academic CV puts publications after experience, and a heading nobody
    // recognises leaves them filed as whatever came before — so a forty-item
    // bibliography read as forty jobs, and the evidence count grew with the
    // length of the bibliography.
    const cv = prepareCvForScoring([
      'EXPERIENCE',
      'Research Fellow, Institute of Things (2018 - 2022)',
      'Publications',
      'On the scalability of ingestion pipelines, Journal of Data, 2020',
    ].join('\n'));
    expect(cv.lines.find((l) => l.text.startsWith('On the scalability'))?.section).toBe('other');
  });
});
