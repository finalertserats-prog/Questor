/**
 * The candidate's profile as the parser read it — Lane 1.
 *
 * Kept free of React so every decision here is unit tested (see
 * web/tests/profileReadModel.test.ts). The shapes mirror
 * `server/src/domain/profileAsRead.ts`; the copy and the judgements about what
 * is worth a second look live here.
 *
 * This screen owes nothing to any role. It says what the document contains and
 * where, and it never says how good a match anybody is — that needs a
 * requirement to be measured against, and it lives in the fit panel.
 */

export interface ReadEvidence {
  /** Index into the lines the scorer kept — a key, never a place in the document. */
  readonly line: number;
  /** 1-based line in the CV as uploaded. Absent on profiles parsed before it was recorded. */
  readonly sourceLine?: number;
  readonly quote: string;
  readonly section: string;
}

export interface ReadRole {
  readonly title: string;
  readonly employer: string;
  readonly startYear?: number;
  readonly endYear?: number;
  readonly current: boolean;
  readonly months?: number;
  readonly evidence: ReadEvidence;
  readonly bullets: readonly ReadEvidence[];
}

export interface ReadTechnology {
  readonly name: string;
  readonly firstYear?: number;
  readonly lastYear?: number;
  readonly monthsUsed?: number;
  readonly recencyYears?: number;
  readonly evidence: readonly ReadEvidence[];
}

export interface ReadQualification {
  readonly level: string;
  readonly field: string;
  readonly displayOnly: { readonly institution: string; readonly year?: number };
  readonly evidence: ReadEvidence;
}

export interface ReadScope {
  readonly kind: 'team' | 'budget' | 'scale' | 'revenue';
  readonly value: string;
  readonly magnitude?: number;
  readonly evidence: ReadEvidence;
}

export interface ProfileRead {
  readonly roles: readonly ReadRole[];
  readonly technologies: readonly ReadTechnology[];
  readonly qualifications: readonly ReadQualification[];
  readonly scope: readonly ReadScope[];
  readonly gaps: readonly { readonly fromYear: number; readonly toYear: number; readonly months: number }[];
  readonly tenure: {
    readonly accountedMonths?: number;
    readonly medianRoleMonths?: number;
    readonly longestRoleMonths?: number;
    readonly roleCount: number;
  };
  readonly redaction: {
    readonly linesRemoved: number;
    readonly kinds: readonly string[];
    readonly injectionLines: readonly number[];
  };
  readonly source: 'deterministic' | 'model_assisted';
  readonly modelNote?: string;
  /**
   * What the reading could not see. Absent on profiles parsed before the
   * parser could say — which means "nothing was assessed", never "nothing was
   * wrong". See server/src/domain/cvParseQuality.ts.
   */
  readonly parseQuality?: ReadParseQuality;
}

/** Mirrors `CvParseSeverity`: what a finding should change, and nothing more. */
export type ReadParseSeverity = 'blocking' | 'review' | 'note';

export interface ReadParseFlag {
  readonly code: string;
  readonly severity: ReadParseSeverity;
  /**
   * Shown verbatim. Written about the READING, never about the candidate:
   * "we could not read a current role" and not "could not verify employment",
   * because the second makes a person the suspect for a failing of ours.
   */
  readonly message: string;
  /** 1-based lines of the uploaded document this points at. */
  readonly sourceLines: readonly number[];
}

export interface ReadParseQuality {
  readonly readable: boolean;
  readonly datedLines: number;
  readonly datedLinesRead: number;
  readonly flags: readonly ReadParseFlag[];
}

/**
 * How sure the reading is of one fact.
 *
 * Three states and no fourth. "read" is the ordinary case; "check" is where the
 * document was ambiguous and the parser refused to guess; "unplaceable" is
 * where we cannot say which line a fact came from, which only happens on
 * profiles parsed before the document line was recorded.
 *
 * There is deliberately no confidence percentage. A number invites a threshold,
 * a threshold invites ignoring everything below it, and the two things a
 * recruiter actually needs to do here — read it, or look at the CV — do not
 * divide at 0.8.
 */
export type ReadState = 'read' | 'check' | 'unplaceable';

/** Where a fact came from, said in the one way a person can act on. */
export function sourceLabel(e: Pick<ReadEvidence, 'sourceLine'>): string {
  return e.sourceLine ? `line ${e.sourceLine}` : 'source not recorded';
}

/**
 * The original line, from the CV text the browser already holds.
 *
 * Not the parsed quote: the point of opening this is to see what the candidate
 * actually wrote, including anything the reading left out on the way past.
 *
 * THE POLICY THIS ASSUMES, written down because it is easy to assume the
 * opposite. What is shown here is the CV **as uploaded**, not the redacted
 * reading. Redaction exists so the SCORER never sees contact details, a
 * photograph, an institution or a graduation year — not to keep them from the
 * recruiter, who already reads an excerpt of the same document on the journey
 * board and who can open the original file regardless. The qualification card
 * makes the same split deliberately, showing institution and year as
 * display-only beside a note saying no score reads them. If that policy ever
 * changes, this function and that card are where it changes.
 *
 * The document is split once by the panel; this convenience form is for callers
 * with a single line to look up, and for tests.
 */
export function splitDocument(rawText: string): string[] {
  return rawText.replace(/\r\n?/g, '\n').split('\n');
}

export function documentLineFrom(lines: readonly string[], sourceLine?: number): string | null {
  // 1-based. 0 is not a line, and treating it as one would print the first line
  // of the CV under every fact whose number failed to be recorded.
  if (!sourceLine || sourceLine < 1) return null;
  const found = lines[sourceLine - 1];
  return found === undefined ? null : found;
}

export function documentLine(rawText: string, sourceLine?: number): string | null {
  return documentLineFrom(splitDocument(rawText), sourceLine);
}

/**
 * Whether a fact's line can actually be opened, and why not when it cannot.
 *
 * Three ways it cannot, and they are different facts about the world. Saying
 * "parsed before the line was recorded" when the truth is "this screen does not
 * have the CV text" tells a recruiter their profile is old when it is not, and
 * sends them to re-parse something that would not help.
 */
export type SourceAvailability = 'ready' | 'not-recorded' | 'no-document' | 'out-of-range';

export function sourceAvailability(
  sourceLine: number | undefined, lines: readonly string[],
): SourceAvailability {
  if (!sourceLine || sourceLine < 1) return 'not-recorded';
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return 'no-document';
  return documentLineFrom(lines, sourceLine) === null ? 'out-of-range' : 'ready';
}

export function sourceTitle(state: SourceAvailability, sourceLine?: number): string {
  switch (state) {
    case 'ready': return 'Show this line of the CV';
    case 'not-recorded': return 'This profile was parsed before the document line was recorded. Re-analysing the CV records it.';
    case 'no-document': return 'The CV text is not available on this screen, so the line cannot be shown.';
    case 'out-of-range': return `Line ${sourceLine} is past the end of the CV text held here.`;
  }
}

/** Why a role is worth a second look, or null when it reads cleanly. */
export function roleConcern(role: ReadRole): string | null {
  if (!role.evidence.sourceLine) return 'We cannot say which line of the CV this came from.';
  if (!role.startYear) return 'No start date could be read, so this role counts towards nothing.';
  if (!role.current && !role.endYear) return 'No end date could be read. Confirm it before tenure is relied on.';
  return null;
}

export function roleState(role: ReadRole): ReadState {
  if (!role.evidence.sourceLine) return 'unplaceable';
  return roleConcern(role) ? 'check' : 'read';
}

/** What the dates say, in words, without inventing any. */
export function roleDates(role: ReadRole): string {
  if (!role.startYear) return 'Dates not read';
  const end = role.current ? 'present' : role.endYear ? String(role.endYear) : '?';
  return `${role.startYear} — ${end}`;
}

export function monthsInWords(months?: number): string | null {
  if (months === undefined || months < 1) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m} mo`;
  if (m === 0) return `${y} yr`;
  return `${y} yr ${m} mo`;
}

/**
 * A technology named in a skills list and nowhere else.
 *
 * A list is a claim; a mention inside a role is evidence of use. Collapsing the
 * two is how "Kafka" on a skills line became experience with Kafka, and it is
 * exactly the kind of thing the interview should ask about rather than the
 * parser decide.
 */
export function technologyIsListedOnly(tech: ReadTechnology): boolean {
  if (tech.evidence.length === 0) return true;
  return tech.evidence.every((e) => e.section === 'skills');
}

export function technologyState(tech: ReadTechnology): ReadState {
  if (tech.evidence.some((e) => e.sourceLine)) {
    return technologyIsListedOnly(tech) ? 'check' : 'read';
  }
  return 'unplaceable';
}

export function technologyNote(tech: ReadTechnology): string | null {
  if (technologyIsListedOnly(tech)) return 'Named in a skills list, not in any role described.';
  const spanned = tech.firstYear && tech.lastYear ? `${tech.firstYear} — ${tech.lastYear}` : null;
  return spanned;
}

/** Plain names for the kinds of thing redaction removes, for the "not read" tab. */
const KIND_WORDS: Readonly<Record<string, string>> = {
  name: 'a name',
  contact: 'contact details',
  photo: 'a photo caption',
  gender: 'a gender field',
  age: 'an age or date of birth',
  marital: 'a marital status',
  nationality: 'a nationality',
  education_provenance: 'an institution or graduation year',
};

export function redactionWords(kinds: readonly string[]): string[] {
  return kinds.map((k) => KIND_WORDS[k] ?? k.replace(/_/g, ' '));
}

export interface ProfileTabCount {
  readonly key: 'experience' | 'technologies' | 'scope' | 'qualifications' | 'not-read';
  readonly label: string;
  readonly count: number;
  /** How many entries on this tab want a human eye. */
  readonly needsCheck: number;
}

export function profileTabs(read: ProfileRead): ProfileTabCount[] {
  const roleChecks = read.roles.filter((r) => roleState(r) !== 'read').length;
  const techChecks = read.technologies.filter((t) => technologyState(t) !== 'read').length;
  return [
    { key: 'experience', label: 'Experience', count: read.roles.length, needsCheck: roleChecks },
    { key: 'technologies', label: 'Technologies', count: read.technologies.length, needsCheck: techChecks },
    { key: 'scope', label: 'Scope', count: read.scope.length, needsCheck: 0 },
    { key: 'qualifications', label: 'Qualifications', count: read.qualifications.length, needsCheck: 0 },
    {
      key: 'not-read',
      label: 'Not read',
      count: read.redaction.linesRemoved + read.redaction.injectionLines.length,
      needsCheck: read.redaction.injectionLines.length,
    },
  ];
}

/**
 * The findings the parser raised about its own reading, worst first.
 *
 * Empty on a profile parsed before the parser could say so — which the reader
 * must treat as "nothing was assessed", not as "nothing was wrong". A screen
 * that turns silence into reassurance is the defect this whole signal exists
 * to fix.
 */
export function parseFlags(read: ProfileRead): readonly ReadParseFlag[] {
  const order: Readonly<Record<ReadParseSeverity, number>> = { blocking: 0, review: 1, note: 2 };
  return [...(read.parseQuality?.flags ?? [])].sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Findings that want a person, as opposed to findings that are context. */
export function parseChecks(read: ProfileRead): readonly ReadParseFlag[] {
  return parseFlags(read).filter((f) => f.severity !== 'note');
}

/** False only where the document turned out not to be a CV at all. */
export function readingIsUsable(read: ProfileRead): boolean {
  return read.parseQuality?.readable !== false;
}

/**
 * "N of M dated lines were read", or null where the parse did not record it.
 *
 * The plainest statement of what the reading missed, and the one a recruiter
 * can check in seconds: the document has this many lines with dates on them,
 * and the reading used this many of them.
 */
export function datedLineCoverage(read: ProfileRead): string | null {
  const q = read.parseQuality;
  if (!q || q.datedLines === 0) return null;
  return `${q.datedLinesRead} of ${q.datedLines} dated lines read`;
}

/**
 * The one-line summary above the tabs.
 *
 * It leads with what was read rather than with a score, and it names the
 * number of things worth checking, because that is the only number on this
 * screen a person can act on. It counts the parser's own findings alongside
 * the per-fact ones: a missing role is not visible in any of the facts that
 * ARE shown, so it can only arrive here.
 */
export function readingSummary(read: ProfileRead): string {
  if (!readingIsUsable(read)) {
    return 'This document could not be read as a CV. Open the file and check it is the right one.';
  }
  const checks = profileTabs(read).reduce((n, t) => n + t.needsCheck, 0) + parseChecks(read).length;
  const roles = read.roles.length === 1 ? '1 role' : `${read.roles.length} roles`;
  const how = read.source === 'model_assisted' ? 'read from the CV, refined by a model' : 'read from the CV';
  if (read.roles.length === 0) return `Nothing could be read from this CV as work history. ${how}.`;
  // "Nothing flagged" is a claim, and it may only be made where something
  // looked. A profile parsed before the parser could report on itself was
  // never examined for what it missed, and printing reassurance over it is
  // the confident silence this whole signal exists to end.
  const checkPart = checks > 0
    ? `${checks} to check`
    : read.parseQuality
      ? 'nothing flagged'
      : 'not checked for gaps — re-analyse the CV to check it';
  return `${roles} ${how} — ${checkPart}.`;
}
