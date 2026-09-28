import { extractCvFacts } from '../../../src/engines/cvFacts.js';
import { totalExperienceYears } from '../../../src/engines/experienceSpan.js';
import type { CvFacts, CvRoleHeld } from '../../../src/domain/cvFacts.js';
import { CV_CORPUS, CORPUS_TODAY, corpusText, type CvExpectation } from './corpus.js';

/**
 * The corpus, scored. One function, used by the baseline report and by the
 * tests, so the number in the commit message and the number the suite enforces
 * cannot drift apart.
 *
 * Every metric is a count over documents the corpus states the answer for.
 * Nothing here reads the parser's own opinion of how it did.
 */

export interface FixtureMeasurement {
  readonly id: string;
  readonly about: string;
  readonly kind: CvExpectation['kind'];
  /** Roles the parser produced, against roles the document contains. */
  readonly rolesFound: number;
  readonly rolesExpected: number;
  readonly rolesMatched: number;
  /** The document has a current role and the parser marked exactly it current. */
  readonly currentRoleExpected: boolean;
  readonly currentRoleCorrect: boolean;
  /** Matched roles whose start and end both came out right. */
  readonly datesCorrect: number;
  /** Catalogue technologies the document evidences, and how many were found. */
  readonly techExpected: number;
  readonly techFound: number;
  /** Technologies reported that the document does not contain. Each one is an invention. */
  readonly techFalsePositives: readonly string[];
  readonly totalYears: number | undefined;
  readonly totalYearsInRange: boolean | null;
  /** Whether the reading raises anything for a person to check. */
  readonly flagCount: number;
  readonly flaggedAsExpected: boolean;
  /** Whether a guard refuses to treat this document as a CV at all. */
  readonly refused: boolean;
}

/** Facts as they are, plus the fields this change adds — so the same file measures before and after. */
type MaybeQualified = CvFacts & {
  readonly parseQuality?: {
    readonly flags?: readonly unknown[];
    readonly readable?: boolean;
  };
};

const norm = (s: string) => s.toLowerCase().normalize('NFC');

function matchRole(roles: readonly CvRoleHeld[], titleContains: string): CvRoleHeld | undefined {
  const needle = norm(titleContains);
  return roles.find((r) => norm(`${r.title} ${r.employer}`).includes(needle));
}

export function measureFixture(expectation: CvExpectation): FixtureMeasurement {
  const text = corpusText(expectation);
  const facts = extractCvFacts(text, { today: CORPUS_TODAY }) as MaybeQualified;
  const years = totalExperienceYears(text, CORPUS_TODAY);

  let rolesMatched = 0;
  let datesCorrect = 0;
  // The match is by title, and two roles must never be credited to one parse.
  const claimed = new Set<CvRoleHeld>();
  let currentRoleExpected = false;
  let currentRoleCorrect = false;

  for (const want of expectation.roles) {
    const available = facts.roles.filter((r) => !claimed.has(r));
    const got = matchRole(available, want.titleContains);
    if (want.endYear === 'present') currentRoleExpected = true;
    if (!got) continue;
    claimed.add(got);
    rolesMatched++;
    const startOk = got.startYear === want.startYear;
    const endOk = want.endYear === 'present' ? got.current === true : got.endYear === want.endYear && !got.current;
    if (startOk && endOk) {
      datesCorrect++;
      if (want.endYear === 'present') currentRoleCorrect = true;
    }
  }

  const found = new Set(facts.technologies.map((t) => t.name.toLowerCase()));
  const techFound = expectation.technologies.filter((t) => found.has(t.toLowerCase())).length;
  const techFalsePositives = expectation.notTechnologies.filter((t) => found.has(t.toLowerCase()));

  const flagCount = facts.parseQuality?.flags?.length ?? 0;
  const refused = facts.parseQuality?.readable === false;
  const totalYearsInRange = expectation.totalYears
    ? years !== undefined && years >= expectation.totalYears[0] && years <= expectation.totalYears[1]
    : null;

  return {
    id: expectation.id,
    about: expectation.about,
    kind: expectation.kind,
    rolesFound: facts.roles.length,
    rolesExpected: expectation.roles.length,
    rolesMatched,
    currentRoleExpected,
    currentRoleCorrect,
    datesCorrect,
    techExpected: expectation.technologies.length,
    techFound,
    techFalsePositives,
    totalYears: years,
    totalYearsInRange,
    flagCount,
    flaggedAsExpected: expectation.expectFlagged ? flagCount > 0 : flagCount === 0,
    refused,
  };
}

export function measureCorpus(): FixtureMeasurement[] {
  return CV_CORPUS.map(measureFixture);
}

export interface CorpusTotals {
  /** Documents whose current role was read as current, over documents that have one. */
  readonly currentRoleRecall: readonly [number, number];
  /** Expected roles found at all, over expected roles. */
  readonly roleRecall: readonly [number, number];
  /** Found roles whose start and end years are both right, over expected roles. */
  readonly dateAccuracy: readonly [number, number];
  /** Expected technologies found, over expected technologies. */
  readonly techRecall: readonly [number, number];
  /** Invented technologies, total. Target zero. */
  readonly techFalsePositives: number;
  /** Documents whose years-of-experience total lands in the range the document supports. */
  readonly totalYearsAccuracy: readonly [number, number];
  /** Documents whose flagging matches what the document deserves. */
  readonly flagAccuracy: readonly [number, number];
  /** Documents that are not CVs and were refused, over documents that are not CVs. */
  readonly noiseRejection: readonly [number, number];
}

export function corpusTotals(rows: readonly FixtureMeasurement[]): CorpusTotals {
  const sum = (pick: (r: FixtureMeasurement) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const noise = rows.filter((r) => r.kind === 'unreadable');
  const withCurrent = rows.filter((r) => r.currentRoleExpected);
  const withYears = rows.filter((r) => r.totalYearsInRange !== null);
  return {
    currentRoleRecall: [withCurrent.filter((r) => r.currentRoleCorrect).length, withCurrent.length],
    roleRecall: [sum((r) => r.rolesMatched), sum((r) => r.rolesExpected)],
    dateAccuracy: [sum((r) => r.datesCorrect), sum((r) => r.rolesExpected)],
    techRecall: [sum((r) => r.techFound), sum((r) => r.techExpected)],
    techFalsePositives: sum((r) => r.techFalsePositives.length),
    totalYearsAccuracy: [withYears.filter((r) => r.totalYearsInRange === true).length, withYears.length],
    flagAccuracy: [rows.filter((r) => r.flaggedAsExpected).length, rows.length],
    noiseRejection: [noise.filter((r) => r.refused).length, noise.length],
  };
}

export { CV_CORPUS, CORPUS_TODAY };
