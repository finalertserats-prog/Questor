import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Real-shaped CVs with what a correct reading of each one looks like.
 *
 * This corpus exists because "the parser should work exceptionally right" is
 * not a thing anyone can check. Numbers are. Every fixture here is a document
 * the parser will meet in production — four languages, day-first and
 * month-first dates, a two-column PDF, a scan, a heading nobody taught it, and
 * a page that is not a CV at all — and every fixture carries the answer, so a
 * change to the parser is measured rather than argued about.
 *
 * The expectations are written from the DOCUMENT, not from what the parser
 * currently does, and by hand: the role dates are read off the page and the
 * years total is the union of those ranges in months, divided by twelve and
 * truncated. `server/tests/cvCorpus.test.ts` enforces them.
 *
 * `today` is fixed. A corpus whose answers change with the calendar measures
 * the clock.
 */

export const CORPUS_TODAY = new Date('2026-09-28T00:00:00Z');

/** What the reading of one role should say. `endYear: 'present'` means still running. */
export interface ExpectedRole {
  /** A distinctive phrase from the job title, matched case-insensitively. */
  readonly titleContains: string;
  readonly startYear: number;
  readonly endYear: number | 'present';
}

export interface CvExpectation {
  readonly id: string;
  readonly file: string;
  /** One line about what this document is testing, for the baseline report. */
  readonly about: string;
  /**
   * `cv` — a readable CV that must be parsed.
   * `unreadable` — must be refused before any score exists.
   * `degraded` — readable enough to store, too damaged to score silently: the
   *   reading must say so.
   */
  readonly kind: 'cv' | 'unreadable' | 'degraded';
  readonly roles: readonly ExpectedRole[];
  /** Technologies the document genuinely evidences (canonical catalogue names). */
  readonly technologies: readonly string[];
  /**
   * Technologies the document does NOT contain. A parser that reports one of
   * these has invented it, and an invented skill is asked about in a real
   * interview.
   */
  readonly notTechnologies: readonly string[];
  /** Whole years of experience the document supports, as a range. */
  readonly totalYears?: readonly [number, number];
  /** True when the reading must raise at least one thing for HR to check. */
  readonly expectFlagged: boolean;
}

export const CV_CORPUS: readonly CvExpectation[] = [
  {
    id: 'en-standard',
    file: 'en-standard.txt',
    about: 'English, month-first, standard headings, three roles, one current',
    kind: 'cv',
    roles: [
      { titleContains: 'Staff Engineer', startYear: 2021, endYear: 'present' },
      { titleContains: 'Senior Software Engineer', startYear: 2018, endYear: 2021 },
      { titleContains: 'Software Engineer', startYear: 2016, endYear: 2018 },
    ],
    technologies: ['Java', 'Python', 'SQL', 'Kafka', 'Kubernetes', 'Terraform', 'PostgreSQL'],
    notTechnologies: ['R', 'C', 'Go', 'Rust'],
    totalYears: [10, 10],
    expectFlagged: false,
  },
  {
    id: 'de-heute',
    file: 'de-heute.txt',
    about: 'German, day-first dates, current role written "heute" — the reported failure',
    kind: 'cv',
    roles: [
      { titleContains: 'Senior Data Engineer', startYear: 2021, endYear: 'present' },
      { titleContains: 'Data Engineer', startYear: 2017, endYear: 2021 },
    ],
    technologies: ['Python', 'SQL', 'Kafka', 'Snowflake', 'Airflow', 'Terraform'],
    notTechnologies: ['R', 'C', 'Go', 'Java'],
    totalYears: [9, 9],
    expectFlagged: false,
  },
  {
    id: 'de-prose-no-tech',
    file: 'de-prose-no-tech.txt',
    about: 'German construction CV with no catalogue technology at all — pure false-positive probe',
    kind: 'cv',
    roles: [
      { titleContains: 'Projektleiter', startYear: 2019, endYear: 'present' },
      { titleContains: 'Bauleiter', startYear: 2014, endYear: 2018 },
    ],
    technologies: [],
    notTechnologies: ['R', 'C', 'Go', 'SQL', 'Java', 'Rust', 'Dart'],
    totalYears: [12, 12],
    expectFlagged: false,
  },
  {
    id: 'fr-aujourdhui',
    file: 'fr-aujourdhui.txt',
    about: 'French, French month names, current role written "aujourd\'hui"',
    kind: 'cv',
    roles: [
      { titleContains: 'Ingénieure logiciel senior', startYear: 2020, endYear: 'present' },
      { titleContains: 'Ingénieure logiciel', startYear: 2017, endYear: 2020 },
    ],
    technologies: ['Python', 'Java', 'SQL', 'Airflow', 'Tableau', 'Docker'],
    notTechnologies: ['R', 'C', 'Go'],
    totalYears: [9, 9],
    expectFlagged: false,
  },
  {
    id: 'es-actualidad',
    file: 'es-actualidad.txt',
    about: 'Spanish, Spanish month names, current role written "actualidad"',
    kind: 'cv',
    roles: [
      { titleContains: 'Analista de datos senior', startYear: 2022, endYear: 'present' },
      { titleContains: 'Analista de datos', startYear: 2019, endYear: 2022 },
    ],
    technologies: ['Python', 'SQL', 'Power BI', 'Airflow', 'PostgreSQL'],
    notTechnologies: ['R', 'C', 'Go'],
    totalYears: [7, 7],
    expectFlagged: false,
  },
  {
    id: 'en-uk-dayfirst',
    file: 'en-uk-dayfirst.txt',
    about: 'UK day-first dates with slashes, no current role',
    kind: 'cv',
    roles: [
      { titleContains: 'Infrastructure Engineer', startYear: 2019, endYear: 2023 },
      { titleContains: 'Support Engineer', startYear: 2015, endYear: 2019 },
    ],
    technologies: ['Linux', 'Ansible', 'Jenkins', 'Python', 'Git'],
    notTechnologies: ['R', 'C', 'Go'],
    totalYears: [8, 8],
    expectFlagged: false,
  },
  {
    id: 'en-two-column',
    file: 'en-two-column.txt',
    about: 'Two-column layout: the dates extract onto their own line under the title',
    kind: 'cv',
    roles: [
      { titleContains: 'Product Designer', startYear: 2022, endYear: 'present' },
      { titleContains: 'Designer', startYear: 2019, endYear: 2022 },
    ],
    technologies: ['Figma'],
    notTechnologies: ['R', 'C', 'Go'],
    totalYears: [7, 7],
    expectFlagged: false,
  },
  {
    id: 'en-unknown-heading',
    file: 'en-unknown-heading.txt',
    about: 'Headings nobody taught it: "Where I\'ve Worked", "Schooling", "What I Know"',
    kind: 'cv',
    roles: [
      { titleContains: 'Lead Data Engineer', startYear: 2020, endYear: 'present' },
      { titleContains: 'Data Engineer', startYear: 2016, endYear: 2019 },
    ],
    technologies: ['Snowflake', 'dbt', 'Spark', 'Scala', 'Airflow', 'Python'],
    notTechnologies: ['R', 'C', 'Go'],
    totalYears: [10, 10],
    expectFlagged: true,
  },
  {
    id: 'en-real-gap',
    file: 'en-real-gap.txt',
    about: 'A genuine career break, dated on both sides — a gap that is not a parse failure',
    kind: 'cv',
    roles: [
      { titleContains: 'Engineering Manager', startYear: 2022, endYear: 'present' },
      { titleContains: 'Senior Engineer', startYear: 2020, endYear: 2022 },
      { titleContains: 'Software Engineer', startYear: 2012, endYear: 2017 },
    ],
    technologies: ['Go', 'MySQL', 'Prometheus', 'Grafana', 'Docker'],
    notTechnologies: ['R', 'C'],
    totalYears: [11, 11],
    expectFlagged: false,
  },
  {
    id: 'en-scanned-sparse',
    file: 'en-scanned-sparse.txt',
    about: 'A scan read by OCR: letters for digits, split words, nothing datable',
    kind: 'degraded',
    roles: [],
    technologies: [],
    notTechnologies: ['R', 'C', 'Go', 'SQL'],
    expectFlagged: true,
  },
  {
    id: 'noise-dashes',
    file: 'noise-dashes.txt',
    about: 'A page of rules, bullets and bars — punctuation, so the upload guard let it through',
    kind: 'unreadable',
    roles: [],
    technologies: [],
    notTechnologies: ['R', 'C', 'Go', 'SQL'],
    expectFlagged: true,
  },
];

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

export function corpusText(expectation: CvExpectation): string {
  return readFileSync(here(expectation.file), 'utf8');
}
