import type { CvFacts, CvGap, CvLine, CvRoleHeld, CvSection } from './cvFacts.js';
import { looksDated, looksLikeCareerBreak, looksOpenEnded } from './cvDates.js';
import { cvReadability } from './cvReadability.js';

/**
 * What the reading could NOT see, said out loud.
 *
 * The defect this exists for is not that the parser got a German CV wrong. It
 * is that it got it wrong CONFIDENTLY. The screen said "1 role read from the
 * CV — nothing flagged" about a document containing two, and every fact on it
 * was marked as read. A recruiter has no way to know the difference between a
 * CV with one job on it and a CV whose second job the parser could not see,
 * because the reading looked identical in both cases. Confident silence is
 * worse than a visible gap: a gap gets checked.
 *
 * Two rules this module is built around, and both are constraints on the
 * DESIGN rather than notes on the implementation:
 *
 * 1. A FLAG IS NEVER A JUDGEMENT ABOUT THE CANDIDATE. "Could not verify
 *    current employment" reads as an accusation; the person becomes the
 *    suspect for a shortcoming in our regex. Every message here is written
 *    about the reading — what WE could not read, and which line of the
 *    document to look at. The subject of the sentence is always us.
 *
 * 2. A FLAG ON EVERY CV IS A FLAG ON NONE. Alert fatigue is not a style
 *    problem, it is the failure mode: a panel that always shows a warning
 *    trains a recruiter to click past the one that matters. So every flag here
 *    needs a REASON the parse can point at — a specific line the document
 *    dated and the reading did not use — and carries the line numbers to open.
 *    Nothing fires on "we are not sure"; they fire on "this line, here".
 *
 * The flags are computed from the parse and the lines, never from the model.
 * A model that is unreachable must not make a CV look cleaner than it is.
 */

export const CV_PARSE_FLAGS = [
  /** Not a CV: there is no readable text in it. No score may be built from it. */
  'not_a_cv',
  /** Readable, but no dated work history came out of it at all. */
  'no_work_history_read',
  /** The document dates lines the reading did not use. */
  'dated_lines_not_read',
  /** Nothing reads as the job they are in now, and a line suggests one exists. */
  'no_current_role_read',
  /** A role has a start and no end, and is not marked current. */
  'role_without_end_date',
  /** No section heading was recognised; the reading worked from the layout. */
  'headings_not_recognised',
  /** A gap sits beside a dated line the reading could not use. */
  'gap_beside_unread_dates',
] as const;

export type CvParseFlagCode = (typeof CV_PARSE_FLAGS)[number];

/**
 * How much a flag should change what happens next, and nothing more.
 *
 * `blocking` stops a score existing — there is no reading to score. `review`
 * asks a person to check one named thing. `note` is context for someone
 * already looking. Three, because a fourth would need a rule for when to use
 * it and there is no fourth decision to make.
 */
export type CvParseSeverity = 'blocking' | 'review' | 'note';

export interface CvParseFlag {
  readonly code: CvParseFlagCode;
  readonly severity: CvParseSeverity;
  /**
   * One sentence, about the reading rather than the candidate, ending in what
   * to do. This is shown verbatim to a recruiter.
   */
  readonly message: string;
  /**
   * 1-based lines of the uploaded document to open. Empty only where the
   * finding is about the document as a whole.
   */
  readonly sourceLines: readonly number[];
}

export interface CvParseQuality {
  /**
   * False when the document is not a CV. Everything downstream fails closed on
   * this: no fit score, no band, no promotion offered, a person reads the file.
   */
  readonly readable: boolean;
  /** Lines the DOCUMENT dates, and how many of them the reading used. */
  readonly datedLines: number;
  readonly datedLinesRead: number;
  readonly flags: readonly CvParseFlag[];
}

/** The worst thing any flag says, for a caller that needs one word. */
export function worstSeverity(quality: CvParseQuality): CvParseSeverity | null {
  if (quality.flags.some((f) => f.severity === 'blocking')) return 'blocking';
  if (quality.flags.some((f) => f.severity === 'review')) return 'review';
  return quality.flags.length ? 'note' : null;
}

/** Whether anything about this reading needs a person. */
export function needsHumanReading(quality: CvParseQuality): boolean {
  return !quality.readable || quality.flags.some((f) => f.severity !== 'note');
}

const NOT_A_CV =
  'This file could not be read as a CV — there is almost no text in it, only spacing and punctuation. '
  + 'Open it and check it is the right document, or paste the CV text instead.';

const listLines = (lines: readonly number[]) => {
  // A line whose document position was never recorded leaves nothing to name,
  // and "check line undefined" is worse than no instruction at all: it reads
  // as a bug to the person we are asking to do the checking.
  if (lines.length === 0) return 'the dated lines';
  const shown = lines.slice(0, 4);
  const rest = lines.length - shown.length;
  const joined = shown.length > 1
    ? `lines ${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
    : `line ${shown[0]}`;
  return rest > 0 ? `${joined} (and ${rest} more)` : joined;
};

export interface ParseQualityInput {
  readonly rawText: string;
  readonly lines: readonly CvLine[];
  readonly roles: readonly CvRoleHeld[];
  readonly gaps: readonly CvGap[];
  /** Line indices (CvLine.index) the role dates were actually read from. */
  readonly datedLinesRead: ReadonlySet<number>;
  /** The section the roles were looked for in. */
  readonly region: CvSection;
  readonly headingsRecognised: boolean;
}

/**
 * The reading's own account of what it missed.
 *
 * Order is the order a person should read them in: whether there is a CV at
 * all, then whether there is a history, then what is missing from it.
 */
export function assessParseQuality(input: ParseQualityInput): CvParseQuality {
  // `prose`, not `readable`. A short CV is a short CV; a page of rules is not
  // a CV. Only the second is a reason to refuse to read at all — the first is
  // reported by `no_work_history_read` below, which says what is actually
  // true about it.
  const readability = cvReadability(input.rawText);
  if (!readability.prose) {
    return {
      readable: false,
      datedLines: 0,
      datedLinesRead: 0,
      flags: [{ code: 'not_a_cv', severity: 'blocking', message: NOT_A_CV, sourceLines: [] }],
    };
  }

  // Only the region roles were looked for in. A year beside a degree or a
  // product version is not a role the reading failed to find, and counting it
  // would put a permanent warning on every CV that mentions one.
  //
  // A declared career break is dated and is deliberately not a role. It is a
  // line the reading UNDERSTOOD and chose not to count, which is the opposite
  // of a line it missed — flagging it would penalise the candidates honest
  // enough to write the break down.
  const dated = input.lines.filter(
    (l) => l.section === input.region && looksDated(l.text) && !looksLikeCareerBreak(l.text),
  );
  const unread = dated.filter((l) => !input.datedLinesRead.has(l.index));
  const unreadSourceLines = unread.map((l) => l.sourceLine).filter((n): n is number => typeof n === 'number');

  const flags: CvParseFlag[] = [];

  if (!input.headingsRecognised) {
    flags.push({
      code: 'headings_not_recognised',
      severity: 'note',
      message: 'None of this CV\'s section headings were recognised, so the reading worked from the layout instead of the labels. '
        + 'Check the roles below against the document.',
      sourceLines: [],
    });
  }

  if (input.roles.length === 0) {
    flags.push({
      code: 'no_work_history_read',
      severity: 'review',
      message: 'No dated work history could be read from this document. '
        + 'Check it against the CV before relying on anything on this screen.',
      sourceLines: unreadSourceLines,
    });
  } else if (unread.length > 0) {
    flags.push({
      code: 'dated_lines_not_read',
      severity: 'review',
      message: `${unread.length} ${unread.length === 1 ? 'line carries dates' : 'lines carry dates'} that the reading could not use. `
        + `Check ${listLines(unreadSourceLines)} against the document.`,
      sourceLines: unreadSourceLines,
    });
  }

  // "We could not read a current role" only where a line suggests there IS
  // one — a date range whose far end is a word rather than a date. Without
  // that condition it would fire on every candidate between jobs, which is
  // both wrong and an accusation.
  const openEnded = unread.filter((l) => looksOpenEnded(l.text));
  const openEndedLines = openEnded.map((l) => l.sourceLine).filter((n): n is number => typeof n === 'number');
  if (input.roles.length > 0 && !input.roles.some((r) => r.current) && openEnded.length > 0) {
    flags.push({
      code: 'no_current_role_read',
      severity: 'review',
      message: 'We could not read a current role from this CV, though a line looks like one that has not ended — '
        + `check ${listLines(openEndedLines)} against the document.`,
      sourceLines: openEndedLines,
    });
  }

  // Only reachable on a model-sharpened parse. The deterministic reader takes
  // both ends of a range or neither, so a start with no end is something the
  // model asserted — which is exactly the claim worth confirming.
  const unended = input.roles.filter((r) => r.startYear && !r.endYear && !r.current);
  for (const role of unended.slice(0, 3)) {
    flags.push({
      code: 'role_without_end_date',
      severity: 'review',
      message: `No end date could be read for "${role.title || 'a role'}", and it is not marked as current. `
        + 'Confirm it before the tenure figures are relied on.',
      sourceLines: role.evidence.sourceLine ? [role.evidence.sourceLine] : [],
    });
  }

  // A gap is only worth raising when it sits beside dates the reading could
  // not use — that is the difference between "they were not working" and "we
  // could not read the job that was there", and only the second is ours.
  const unreadYears = new Set<number>();
  for (const line of unread) {
    for (const m of line.text.matchAll(/\b(?:19|20)\d{2}\b/g)) unreadYears.add(Number(m[0]));
  }
  const suspect = input.gaps.filter((g) => [...unreadYears].some((y) => y >= g.fromYear && y <= g.toYear));
  for (const gap of suspect.slice(0, 2)) {
    flags.push({
      code: 'gap_beside_unread_dates',
      severity: 'review',
      message: `The break the reading shows between ${gap.fromYear} and ${gap.toYear} sits next to a dated line it could not use, `
        + 'so it may be a gap in the reading rather than in the career. Check the CV over those years.',
      sourceLines: unreadSourceLines,
    });
  }

  return { readable: true, datedLines: dated.length, datedLinesRead: dated.length - unread.length, flags };
}

/**
 * The assessment on a set of facts, or null where none was made.
 *
 * Null, and deliberately not an empty clean one. A profile parsed before this
 * signal existed was never checked, and defaulting it to "no flags" would
 * print "nothing flagged" over a reading nobody has ever examined — which is
 * the exact confident silence this module was written to end, reintroduced by
 * a convenience default. Callers have to say what they do about "we do not
 * know", because it is a different answer from "we looked and it was fine".
 */
export function parseQualityOf(facts: Pick<CvFacts, 'parseQuality'>): CvParseQuality | null {
  return facts.parseQuality ?? null;
}

/**
 * The same assessment, made again after a model has sharpened the parse.
 *
 * It has to be made again rather than carried forward: the model's whole job
 * is to find roles the deterministic reader missed, so a flag saying "these
 * lines were not read" goes stale the moment it succeeds — and a stale flag is
 * the alert-fatigue failure this module exists to avoid. What the model cannot
 * do is make the flags disappear by being unreachable: the deterministic
 * assessment is what a failed model call leaves behind.
 *
 * A role's dates come either from its own line or from the one below it, so
 * both count as read. That is the same rule the deterministic reader follows;
 * the model's reply names a line rather than telling us which of the two it
 * took. The neighbour is found by POSITION in the kept lines rather than by
 * adding one to the index — `CvLine.index` is a key, and an injection line
 * dropped from the scoreable set is enough to make index + 1 point at nothing
 * or, worse, at some other role's heading.
 */
export function reassessAfterMerge(facts: CvFacts, rawText: string): CvParseQuality {
  const region: CvSection = facts.lines.some((l) => l.section === 'experience') ? 'experience' : 'summary';
  const read = new Set<number>();
  for (const role of facts.roles) {
    if (!role.startYear) continue;
    read.add(role.evidence.line);
    const at = facts.lines.findIndex((l) => l.index === role.evidence.line);
    const next = at >= 0 ? facts.lines[at + 1] : undefined;
    if (next) read.add(next.index);
  }
  return assessParseQuality({
    rawText,
    lines: facts.lines,
    roles: facts.roles,
    gaps: facts.gaps,
    datedLinesRead: read,
    region,
    headingsRecognised: region === 'experience',
  });
}
