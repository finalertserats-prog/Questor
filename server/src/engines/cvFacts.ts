import { TECHNOLOGIES, mentionsTechnologyInProse } from '../domain/techStack.js';
import { firstDateRange, looksLikeCareerBreak, stripDateRanges } from '../domain/cvDates.js';
import { assessParseQuality } from '../domain/cvParseQuality.js';
import { prepareCvForScoring, scoreableLines, type ScoreableCv } from './cvRedaction.js';
import { spellingsOf } from './fitEvidence.js';
import type {
  CvEvidence, CvFacts, CvGap, CvLine, CvQualification, CvRoleHeld, CvScopeFact, CvScopeKind, CvSection,
  CvTechnologyUse, CvTenure,
} from '../domain/cvFacts.js';

/**
 * The deterministic CV parse: roles with dates, technologies with recency,
 * scope figures, qualifications, gaps and tenure — each carrying the line it
 * came from.
 *
 * This is the base, and it is the floor. A model may sharpen it
 * (engines/cvFactsLlm.ts) but never replaces it: if the model is unreachable,
 * slow, or answers something the schema rejects, these facts are what gets
 * scored, and HR sees the same panel either way.
 */

export interface DatePoint { readonly year: number; readonly month: number }
export interface DateRange { readonly start: DatePoint; readonly end: DatePoint | null; readonly current: boolean }

/**
 * A "Mar 2019 – Present" style range, or null when the line carries no usable
 * one.
 *
 * WHAT A DATE RANGE IS lives in domain/cvDates.ts, shared with the years-of-
 * experience reader in engines/experienceSpan.ts. The two used to hold
 * separate regexes with separate vocabularies, and the difference was a
 * defect, not a design: a timeline strip reading "2017 - 18" counted towards
 * the years total while producing no listed role, and a German CV whose
 * current job ran "01.03.2021 – heute" produced neither, because `heute` was
 * in no vocabulary at all. What stays here is what this reader does with a
 * range: a month where the CV wrote none is January, and a range that ends
 * before it starts is refused.
 */
export function parseDateRange(line: string, today = new Date()): DateRange | null {
  const range = firstDateRange(line);
  if (!range) return null;
  const start = { year: range.start.year, month: range.start.month ?? 1 };
  const end = range.ongoing
    ? { year: today.getFullYear(), month: today.getMonth() + 1 }
    : { year: range.end!.year, month: range.end!.month ?? 1 };
  if (end.year < start.year) return null;
  return { start, end, current: range.ongoing };
}

function monthsBetween(range: DateRange): number {
  return Math.max(1, (range.end!.year - range.start.year) * 12 + (range.end!.month - range.start.month) + 1);
}

const evidenceOf = (line: CvLine): CvEvidence => ({ line: line.index, sourceLine: line.sourceLine, quote: line.text, section: line.section });

// --- Roles -------------------------------------------------------------------

const BULLET = /^[-–•*●▪·]/;
/** "Engineer, Acme" and "Engineer at Acme" and "Engineer | Acme" all split here. */
const TITLE_SEPARATOR = /\s*(?:[,|–—])\s+|\s+(?:at|@|-)\s+/;
const ROLE_WORDS = /\b(engineer|developer|manager|analyst|designer|scientist|architect|consultant|director|lead|head|officer|specialist|administrator|associate|executive|coordinator|technician|researcher|intern|principal|partner|founder|owner|president|vp|cto|cio|ceo)\b/i;
const MAX_ROLE_LINE_CHARS = 140;
const MAX_ROLES = 14;

/**
 * A role heading: a line in the experience region that names a job and is not
 * a bullet. The dates may sit on it or on the line just below — both are common
 * and both are read, because a role whose dates are missed becomes a fake gap.
 *
 * A line the candidate wrote to say they were NOT working is not a job. It
 * carries a date range and a comma like any other, so it used to be read as
 * one, and "Career break, full-time carer — Apr 2017 - Feb 2020" became three
 * years of employment.
 */
function isRoleHeading(line: CvLine, next: CvLine | undefined, region: CvSection): boolean {
  if (line.section !== region) return false;
  const t = line.text;
  if (!t || t.length > MAX_ROLE_LINE_CHARS || BULLET.test(t)) return false;
  if (looksLikeCareerBreak(t)) return false;
  if (!ROLE_WORDS.test(t) && !TITLE_SEPARATOR.test(t)) return false;
  return Boolean(parseDateRange(t)) || Boolean(next && next.text.length < MAX_ROLE_LINE_CHARS && parseDateRange(next.text));
}

/**
 * Where the roles are.
 *
 * Normally the section the CV labelled. But a heading nobody taught the
 * vocabulary — "Where I've Worked", "My Track Record" — leaves every line
 * under it filed as `summary`, `isRoleHeading` returns false on all of them,
 * and the CV yields ZERO roles. The candidate is marked down for the words
 * they chose as headings, silently.
 *
 * So when a document turns out to have no experience section at all, the
 * reading falls back to the lines that fell through — and says it did, via the
 * `headings_not_recognised` flag. It is a fallback and not a default: where
 * the CV did label its experience, the label wins, because a labelled section
 * is better evidence than a shape.
 */
function experienceRegion(lines: readonly CvLine[]): { region: CvSection; recognised: boolean } {
  return lines.some((l) => l.section === 'experience')
    ? { region: 'experience', recognised: true }
    : { region: 'summary', recognised: false };
}

/** The capture is the point: `exec(...)[1]` is the parenthesised description itself. */
const EMPLOYER_CONTEXT = /\(([^)]*\b(?:employees?|people|staff|fortune \d+|startup|scale-?up|\$\d|revenue|headcount|seed|series [a-e]|fintech|healthcare|retail|banking|telecom|saas|e-?commerce|manufacturing|logistics|insurance|media|education|government|non-?profit)\b[^)]*)\)/i;

function splitTitleEmployer(text: string): { title: string; employer: string } {
  const withoutDates = stripDateRanges(text).replace(/^[\s()|,;–—-]+/, '').replace(/[\s()|,;–—-]+$/, '').trim();
  const parts = withoutDates.split(TITLE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { title: withoutDates.slice(0, 80), employer: '' };
  // The half that reads like a job is the title, whichever side it sits on.
  const titleFirst = ROLE_WORDS.test(parts[0]) || !ROLE_WORDS.test(parts[1]);
  return titleFirst
    ? { title: parts[0].slice(0, 80), employer: parts.slice(1).join(' ').slice(0, 80) }
    : { title: parts[1].slice(0, 80), employer: parts[0].slice(0, 80) };
}

export interface RolesRead {
  readonly roles: readonly CvRoleHeld[];
  /**
   * The lines the dates actually came from — which is not always the role's
   * own line, because a two-column CV puts them on the next one. Compared
   * against the lines that merely LOOK dated, this is how the reading knows
   * what it missed.
   */
  readonly datedLinesRead: ReadonlySet<number>;
  readonly region: CvSection;
  readonly headingsRecognised: boolean;
}

function extractRoles(lines: readonly CvLine[], today: Date): RolesRead {
  const { region, recognised } = experienceRegion(lines);
  const roles: CvRoleHeld[] = [];
  const datedLinesRead = new Set<number>();
  let current: { role: CvRoleHeld; bullets: CvEvidence[] } | null = null;

  const close = () => {
    if (!current) return;
    roles.push({ ...current.role, bullets: current.bullets });
    current = null;
  };

  for (let i = 0; i < lines.length && roles.length < MAX_ROLES; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (isRoleHeading(line, next, region)) {
      close();
      const onOwnLine = Boolean(parseDateRange(line.text, today));
      const dateSource = onOwnLine ? line : next;
      const range = parseDateRange(dateSource?.text ?? '', today);
      if (range && dateSource) datedLinesRead.add(dateSource.index);
      const { title, employer } = splitTitleEmployer(line.text);
      const context = EMPLOYER_CONTEXT.exec(`${line.text} ${next?.text ?? ''}`)?.[1];
      current = {
        role: {
          title, employer,
          ...(range ? { startYear: range.start.year, endYear: range.end!.year, months: monthsBetween(range) } : {}),
          current: Boolean(range?.current),
          ...(context ? { employerContext: context.trim().slice(0, 80) } : {}),
          evidence: evidenceOf(line),
          bullets: [],
        },
        bullets: [],
      };
      continue;
    }
    if (current && line.section === region && line.text.length > 12) {
      current.bullets.push(evidenceOf(line));
    } else if (current && line.section !== region) {
      close();
    }
  }
  close();
  return { roles, datedLinesRead, region, headingsRecognised: recognised };
}

// --- Technologies -------------------------------------------------------------

/**
 * A technology's recency and duration come from the role whose bullets mention
 * it, which is the only honest way to say "used Kafka for four years, last two
 * years ago". A mention in a skills list has neither, and is reported as a
 * mention rather than dressed up as experience.
 */
function extractTechnologies(lines: readonly CvLine[], roles: readonly CvRoleHeld[], today: Date): CvTechnologyUse[] {
  const byLine = new Map<number, CvRoleHeld>();
  for (const role of roles) {
    byLine.set(role.evidence.line, role);
    for (const b of role.bullets) byLine.set(b.line, role);
  }

  const out: CvTechnologyUse[] = [];
  for (const tech of TECHNOLOGIES) {
    // The catalogue's own aliases, plus the spellings the trade uses that the
    // catalogue has never carried — "RDBMS" and "relational databases" for SQL,
    // "K8s" for Kubernetes. Without them a CV written in the register of the
    // job gets no DATES for the technology it has been using for a decade, and
    // a decade of use reads as a name in a list.
    const spellings = [...new Set([tech.name, ...(tech.aliases ?? []), ...spellingsOf(tech.name)])];
    const evidence: CvEvidence[] = [];
    let firstYear: number | undefined;
    let lastYear: number | undefined;
    let months = 0;
    const counted = new Set<string>();

    for (const line of lines) {
      if (!spellings.some((s) => mentionsTechnologyInProse(line.text, s))) continue;
      if (evidence.length < 4) evidence.push(evidenceOf(line));
      const role = byLine.get(line.index);
      if (!role?.startYear) continue;
      firstYear = firstYear === undefined ? role.startYear : Math.min(firstYear, role.startYear);
      lastYear = lastYear === undefined ? role.endYear : Math.max(lastYear ?? 0, role.endYear ?? 0);
      const key = `${role.evidence.line}`;
      if (!counted.has(key) && role.months) { counted.add(key); months += role.months; }
    }
    if (evidence.length === 0) continue;
    out.push({
      name: tech.name,
      ...(firstYear ? { firstYear } : {}),
      ...(lastYear ? { lastYear, recencyYears: Math.max(0, today.getFullYear() - lastYear) } : {}),
      ...(months ? { monthsUsed: months } : {}),
      evidence,
    });
  }
  return out;
}

// --- Scope --------------------------------------------------------------------

const SCOPE_PATTERNS: ReadonlyArray<{ readonly kind: CvScopeKind; readonly re: RegExp }> = [
  { kind: 'team', re: /\b(?:team of|led|managed|mentored|supervised|grew(?: the team)? to)\s+(\d{1,4})\s*(?:\+)?\s*(?:direct reports?|engineers?|developers?|people|staff|analysts?|designers?|members?)?\b/i },
  // Headcount written the way it is written outside a corporate org chart. "Led
  // a section of 12" is an officer describing twelve direct reports, and the
  // pattern above misses it because the number does not follow the verb — so
  // eight years of leading people read as no evidence of leading anyone. The
  // nouns are the ones CVs actually use for a group of people, in and out of
  // uniform.
  { kind: 'team', re: /\b(?:section|platoon|squad|crew|watch|shift|unit|cell|troop|detachment|department|division|practice|chapter|pod|ward|branch|group|function)\s+of\s+(\d{1,4})\b/i },
  { kind: 'budget', re: /(?:budget|p&l|spend|cost base)[^.\n]{0,24}?([$£€₹]\s?\d[\d.,]*\s?(?:k|m|bn|billion|million|crore|lakh)?)/i },
  { kind: 'revenue', re: /(?:revenue|arr|mrr|gmv|sales)[^.\n]{0,24}?([$£€₹]\s?\d[\d.,]*\s?(?:k|m|bn|billion|million|crore|lakh)?)/i },
  { kind: 'scale', re: /\b(\d[\d.,]*\s?(?:k|m|bn|million|billion|crore|lakh)?\+?\s*(?:[a-z]+\s+)?(?:users?|customers?|clients?|analysts?|employees?|requests?|transactions?|events?|records?|rows?|orders?|sites?|stores?|markets?|countries|qps|tps|rps|daily active|monthly active|dau|mau))\b/i },
  // Data volume is scope too, and a data role states it far more often than it
  // states a headcount: "4TB/day" is the size of the thing being run.
  { kind: 'scale', re: /\b(\d[\d.,]*\s?(?:kb|mb|gb|tb|pb)(?:\s*\/\s*(?:day|hour|week|month|sec|second))?)\b/i },
];

function extractScope(lines: readonly CvLine[]): CvScopeFact[] {
  const out: CvScopeFact[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    for (const { kind, re } of SCOPE_PATTERNS) {
      const m = re.exec(line.text);
      if (!m) continue;
      const value = m[1].trim();
      const key = `${kind}:${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const magnitude = parseMagnitude(value);
      out.push({ kind, value, ...(magnitude === null ? {} : { magnitude }), evidence: evidenceOf(line) });
    }
    if (out.length >= 12) break;
  }
  return out;
}

function parseMagnitude(value: string): number | null {
  const m = /(\d[\d.,]*)\s*(k|m|bn|billion|million|crore|lakh)?/i.exec(value);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (Number.isNaN(base)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const factor = unit === 'k' ? 1e3 : unit === 'm' || unit === 'million' ? 1e6 : unit === 'bn' || unit === 'billion' ? 1e9 : unit === 'crore' ? 1e7 : unit === 'lakh' ? 1e5 : 1;
  return base * factor;
}

// --- Qualifications -----------------------------------------------------------

const LEVEL_PATTERNS: ReadonlyArray<{ readonly level: CvQualification['level']; readonly re: RegExp }> = [
  { level: 'doctorate', re: /\b(ph\.?d|doctorate|d\.?phil)\b/i },
  { level: 'master', re: /\b(m\.?tech|m\.?e\b|m\.?sc|m\.?s\b|m\.?c\.?a|m\.?b\.?a|master)\b/i },
  { level: 'bachelor', re: /\b(b\.?tech|b\.?e\b|b\.?sc|b\.?s\b|b\.?c\.?a|b\.?com|b\.?a\b|bachelor)\b/i },
  { level: 'diploma', re: /\b(diploma|associate(?:'?s)? degree)\b/i },
];

const FIELD_RE = /\b(?:in|of)\s+([A-Za-z][A-Za-z &/+-]{2,40})/i;

function extractQualifications(lines: readonly CvLine[], originals: ReadonlyMap<number, string>): CvQualification[] {
  const out: CvQualification[] = [];
  for (const line of lines) {
    if (line.section !== 'education' && line.section !== 'certifications') continue;
    const found = LEVEL_PATTERNS.find(({ re }) => re.test(line.text));
    const level = found?.level ?? (line.section === 'certifications' ? 'certification' : null);
    if (!level) continue;
    // The institution and year exist only here, only for display, and only
    // because HR should be able to read the CV back as it was written.
    const original = originals.get(line.index) ?? line.text;
    const year = /\b(19|20)\d{2}\b/.exec(original)?.[0];
    out.push({
      level,
      field: (FIELD_RE.exec(line.text)?.[1] ?? line.text.replace(found?.re ?? /$^/, '')).trim().slice(0, 60),
      displayOnly: {
        institution: original.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s{2,}/g, ' ').replace(/[,;|\s]+$/, '').trim().slice(0, 120),
        ...(year ? { year: Number(year) } : {}),
      },
      evidence: evidenceOf(line),
    });
    if (out.length >= 10) break;
  }
  return out;
}

// --- Tenure and gaps -----------------------------------------------------------

const MIN_GAP_MONTHS = 4;

function tenureAndGaps(roles: readonly CvRoleHeld[]): { tenure: CvTenure; gaps: CvGap[] } {
  const dated = roles.filter((r) => typeof r.months === 'number' && r.startYear && r.endYear);
  const months = dated.map((r) => r.months!).sort((a, b) => a - b);
  const tenure: CvTenure = {
    roleCount: roles.length,
    ...(months.length ? {
      accountedMonths: months.reduce((a, b) => a + b, 0),
      medianRoleMonths: months[Math.floor((months.length - 1) / 2)],
      longestRoleMonths: months[months.length - 1],
    } : {}),
  };

  const ordered = [...dated].sort((a, b) => a.startYear! - b.startYear!);
  const gaps: CvGap[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previousEnd = Math.max(...ordered.slice(0, i).map((r) => r.endYear!));
    const gapMonths = (ordered[i].startYear! - previousEnd) * 12;
    if (gapMonths >= MIN_GAP_MONTHS) gaps.push({ fromYear: previousEnd, toYear: ordered[i].startYear!, months: gapMonths });
  }
  return { tenure, gaps };
}

// --- Stated location and work authorisation -------------------------------------

const LOCATION_RE = /(?:[Bb]ased (?:in|out of)|[Ll]ocated in|[Rr]elocating to|[Oo]pen to relocating to|[Ww]illing to relocate to)\s+([A-Z][A-Za-z .'-]{2,40})/;
const WORK_AUTH_RE = /\b(?:authori[sz]ed to work|right to work|work permit|eligible to work|no sponsorship required|requires? sponsorship|work authorisation|work authorization)\b/i;

// --- The parse ---------------------------------------------------------------

export interface ExtractOptions { readonly today?: Date }

/** Structured, evidence-backed facts from a CV. Never throws: a CV it cannot read yields empty facts. */
export function extractCvFacts(rawText: string, opts: ExtractOptions = {}): CvFacts {
  const cv: ScoreableCv = prepareCvForScoring(rawText);
  return factsFromPreparedCv(cv, rawText, opts);
}

/** The same parse when the caller has already prepared the CV (so redaction runs once). */
export function factsFromPreparedCv(cv: ScoreableCv, rawText: string, opts: ExtractOptions = {}): CvFacts {
  const today = opts.today ?? new Date();
  const lines = scoreableLines(cv);
  const read = extractRoles(lines, today);
  const roles = read.roles;
  const { tenure, gaps } = tenureAndGaps(roles);
  const location = lines.find((l) => LOCATION_RE.test(l.text));
  const workAuth = lines.find((l) => WORK_AUTH_RE.test(l.text));

  return {
    roles,
    technologies: extractTechnologies(lines, roles, today),
    qualifications: extractQualifications(lines, cv.educationOriginals),
    scope: extractScope(lines),
    gaps,
    tenure,
    ...(location ? { statedLocation: evidenceOf(location) } : {}),
    ...(workAuth ? { statedWorkAuthorisation: evidenceOf(workAuth) } : {}),
    lines,
    redaction: cv.redaction,
    // Computed from the deterministic parse and the document, never from the
    // model: a model that is unreachable must not make a CV look cleaner than
    // it is, and the model refinement in cvFactsLlm.ts carries this forward
    // rather than recomputing it.
    parseQuality: assessParseQuality({
      rawText,
      lines,
      roles,
      gaps,
      datedLinesRead: read.datedLinesRead,
      region: read.region,
      headingsRecognised: read.headingsRecognised,
    }),
    source: 'deterministic',
  };
}
