import { TECHNOLOGIES, mentionsTechnology } from '../domain/techStack.js';
import { prepareCvForScoring, scoreableLines, type ScoreableCv } from './cvRedaction.js';
import type {
  CvEvidence, CvFacts, CvGap, CvLine, CvQualification, CvRoleHeld, CvScopeFact, CvScopeKind,
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

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_WORD = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const YEAR = '((?:19|20)\\d{2})';
const POINT = `(?:${MONTH_WORD}\\.?[\\s,/-]*${YEAR}|${YEAR}|(\\d{1,2})[/.]${YEAR})`;
const PRESENT = '(present|current|now|to date|till date|ongoing|date)';
const RANGE_RE = new RegExp(`${POINT}\\s*(?:-|–|—|to|until|\\u2192)\\s*(?:${POINT}|${PRESENT})`, 'i');

export interface DatePoint { readonly year: number; readonly month: number }
export interface DateRange { readonly start: DatePoint; readonly end: DatePoint | null; readonly current: boolean }

/** A "Mar 2019 – Present" style range, or null when the line carries no usable one. */
export function parseDateRange(line: string, today = new Date()): DateRange | null {
  const m = RANGE_RE.exec(line);
  if (!m) return null;
  const start = pointFrom(m[1], m[2], m[3], m[4], m[5]);
  if (!start) return null;
  const current = Boolean(m[11]);
  const end = current ? { year: today.getFullYear(), month: today.getMonth() + 1 } : pointFrom(m[6], m[7], m[8], m[9], m[10]);
  if (!end) return null;
  if (end.year < start.year) return null;
  return { start, end, current };
}

function pointFrom(monthWord?: string, yearAfterMonth?: string, bareYear?: string, numericMonth?: string, yearAfterNumeric?: string): DatePoint | null {
  if (monthWord && yearAfterMonth) return { year: Number(yearAfterMonth), month: MONTHS[monthWord.slice(0, 4).toLowerCase()] ?? MONTHS[monthWord.slice(0, 3).toLowerCase()] ?? 1 };
  if (numericMonth && yearAfterNumeric) return { year: Number(yearAfterNumeric), month: Math.min(12, Math.max(1, Number(numericMonth))) };
  if (bareYear) return { year: Number(bareYear), month: 1 };
  return null;
}

function monthsBetween(range: DateRange): number {
  return Math.max(1, (range.end!.year - range.start.year) * 12 + (range.end!.month - range.start.month) + 1);
}

const evidenceOf = (line: CvLine): CvEvidence => ({ line: line.index, quote: line.text, section: line.section });

// --- Roles -------------------------------------------------------------------

const BULLET = /^[-–•*●▪·]/;
/** "Engineer, Acme" and "Engineer at Acme" and "Engineer | Acme" all split here. */
const TITLE_SEPARATOR = /\s*(?:[,|–—])\s+|\s+(?:at|@|-)\s+/;
const ROLE_WORDS = /\b(engineer|developer|manager|analyst|designer|scientist|architect|consultant|director|lead|head|officer|specialist|administrator|associate|executive|coordinator|technician|researcher|intern|principal|partner|founder|owner|president|vp|cto|cio|ceo)\b/i;
const MAX_ROLE_LINE_CHARS = 140;
const MAX_ROLES = 14;

/**
 * A role heading: a line in the experience section that names a job and is not
 * a bullet. The dates may sit on it or on the line just below — both are common
 * and both are read, because a role whose dates are missed becomes a fake gap.
 */
function isRoleHeading(line: CvLine, next: CvLine | undefined): boolean {
  if (line.section !== 'experience') return false;
  const t = line.text;
  if (!t || t.length > MAX_ROLE_LINE_CHARS || BULLET.test(t)) return false;
  if (!ROLE_WORDS.test(t) && !TITLE_SEPARATOR.test(t)) return false;
  return Boolean(parseDateRange(t)) || Boolean(next && next.text.length < MAX_ROLE_LINE_CHARS && parseDateRange(next.text));
}

/** The capture is the point: `exec(...)[1]` is the parenthesised description itself. */
const EMPLOYER_CONTEXT = /\(([^)]*\b(?:employees?|people|staff|fortune \d+|startup|scale-?up|\$\d|revenue|headcount|seed|series [a-e]|fintech|healthcare|retail|banking|telecom|saas|e-?commerce|manufacturing|logistics|insurance|media|education|government|non-?profit)\b[^)]*)\)/i;

function splitTitleEmployer(text: string): { title: string; employer: string } {
  const withoutDates = text.replace(RANGE_RE, '').replace(/[\s()|,;–—-]+$/, '').trim();
  const parts = withoutDates.split(TITLE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { title: withoutDates.slice(0, 80), employer: '' };
  // The half that reads like a job is the title, whichever side it sits on.
  const titleFirst = ROLE_WORDS.test(parts[0]) || !ROLE_WORDS.test(parts[1]);
  return titleFirst
    ? { title: parts[0].slice(0, 80), employer: parts.slice(1).join(' ').slice(0, 80) }
    : { title: parts[1].slice(0, 80), employer: parts[0].slice(0, 80) };
}

function extractRoles(lines: readonly CvLine[], today: Date): CvRoleHeld[] {
  const roles: CvRoleHeld[] = [];
  let current: { role: CvRoleHeld; bullets: CvEvidence[] } | null = null;

  const close = () => {
    if (!current) return;
    roles.push({ ...current.role, bullets: current.bullets });
    current = null;
  };

  for (let i = 0; i < lines.length && roles.length < MAX_ROLES; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (isRoleHeading(line, next)) {
      close();
      const dateLine = parseDateRange(line.text, today) ? line.text : (next?.text ?? '');
      const range = parseDateRange(dateLine, today);
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
    if (current && line.section === 'experience' && line.text.length > 12) {
      current.bullets.push(evidenceOf(line));
    } else if (current && line.section !== 'experience') {
      close();
    }
  }
  close();
  return roles;
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
    const spellings = [tech.name, ...(tech.aliases ?? [])];
    const evidence: CvEvidence[] = [];
    let firstYear: number | undefined;
    let lastYear: number | undefined;
    let months = 0;
    const counted = new Set<string>();

    for (const line of lines) {
      if (!spellings.some((s) => mentionsTechnology(line.text, s))) continue;
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
export function factsFromPreparedCv(cv: ScoreableCv, _rawText: string, opts: ExtractOptions = {}): CvFacts {
  const today = opts.today ?? new Date();
  const lines = scoreableLines(cv);
  const roles = extractRoles(lines, today);
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
    source: 'deterministic',
  };
}
