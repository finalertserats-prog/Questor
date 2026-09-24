/**
 * How long a candidate has actually been working, from the date ranges their
 * CV writes down.
 *
 * The previous answer was the span between the earliest and the latest
 * four-digit number anywhere in the document that happened to look like a
 * year. That is wrong in two directions at once, and both were live:
 *
 * - It counted numbers that were never dates. A candidate whose address is
 *   `kvishwkarma1995@gmail.com` was credited with 31 years of experience,
 *   because 1995 is in her email. She has 13. That figure is printed on her
 *   profile and it feeds band calibration, so the interview she was given was
 *   pitched at an executive who had been working since before she was born.
 * - It counted the gaps. A candidate who worked 2010-2012, took eight years
 *   out and came back in 2020 reads as twelve years, not four.
 *
 * So: find ranges, not years — a range needs two endpoints and something
 * between them saying it is a range — then measure the union of those ranges
 * in months. The union is what makes overlapping roles (a promotion recorded
 * as two entries, a consultancy alongside a staff job) count once.
 *
 * Deliberately conservative. Where the CV gives no range this returns
 * undefined rather than a guess, because "we do not know" is a state the rest
 * of the system already handles and a wrong number is not.
 */

export interface ExperienceRange {
  /** Months since year 0, so arithmetic needs no calendar. */
  readonly startMonth: number;
  readonly endMonth: number;
  /** The range had no end date: "2019 - Present". */
  readonly ongoing: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_WORD = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const YEAR = '(?:19|20)\\d{2}';
const DASH = '(?:-|–|—|~|to|through|until|till)';
const ONGOING = '(?:present|current|now|to\\s*date|till\\s*date|ongoing|date)';

/**
 * A range, in the shapes CVs actually write:
 *   "August 2025 – June 2026"   "2021 - 2024"   "Jul 2019 – Oct 2020"
 *   "2017 - 18"                 "Mar 2024 - Present"
 * The two-digit end ("2017 - 18") is common on timeline strips and is read as
 * the same century as its start.
 */
const RANGE = new RegExp(
  `(?:(${MONTH_WORD})[\\s.,]*)?(${YEAR})\\s*${DASH}\\s*(?:(${ONGOING})|(?:(${MONTH_WORD})[\\s.,]*)?(${YEAR}|\\d{2})(?![\\d]))`,
  'gi',
);

/**
 * Text that is not prose and must not be scanned for dates: an email address,
 * a URL, and a run of digits long enough to be a phone number or an id. The
 * 1995 that started all of this lived in the first of these.
 */
const NOT_PROSE = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  /\b(?:https?:\/\/|www\.)\S+/g,
  /\b[\w-]+\.(?:com|org|net|io|co|in|edu|gov)(?:\/\S*)?/gi,
  // Phone numbers, and only phone numbers. A looser rule — any run of digits,
  // spaces, dots and dashes — swallowed "2018 - 2021" whole, and a career
  // timeline strip reading "2017 - 18   2021 - 22   2022 - 25" is made of
  // nothing else, so the entire strip vanished before it could be read. A year
  // is four digits, so requiring a + prefix, brackets, a grouped number, or
  // seven digits in a row can never take one.
  /\+\d[\d\s().-]{7,}\d/g,
  /\(\d{2,4}\)\s*\d{3,4}[\s.-]?\d{3,4}/g,
  /\b\d{3,4}[-.\s]\d{3,4}[-.\s]\d{4}\b/g,
  /\b\d{7,}\b/g,
];

/**
 * Products whose names end in a year. A skills line reading "SQL Server 2012 -
 * 2016" is naming two versions of a database, not six years of someone's life,
 * and a CV that lists "Office 365" and "ISO 9001" beside it has said nothing
 * at all about when its author worked.
 */
const VERSIONED_PRODUCT = new RegExp(
  '\\b(?:sql\\s*server|windows(?:\\s*server)?|office|exchange|sharepoint|visual\\s*studio|'
  + 'ms\\s*project|autocad|solidworks|photoshop|illustrator|indesign|excel|word|outlook|'
  + 'quickbooks|sage|tally|sap|revit|matlab|labview|iso|ieee|rfc|section|form|标准)'
  + '\\s*\\d{3,4}(?:\\s*(?:-|–|—|\\/|,|&|and)\\s*\\d{2,4})*',
  'gi',
);

/** Blank out anything a date cannot legitimately be found inside. */
export function proseOnly(text: string): string {
  let out = text.replace(VERSIONED_PRODUCT, (m) => ' '.repeat(m.length));
  for (const re of NOT_PROSE) out = out.replace(re, (m) => ' '.repeat(m.length));
  return out;
}

function monthIndex(word: string | undefined): number | null {
  if (!word) return null;
  const key = word.toLowerCase().replace(/\./g, '').slice(0, 4);
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)] ?? null;
}

function absMonth(year: number, month: number | null, fallback: number): number {
  return year * 12 + (month ?? fallback);
}

/**
 * Every employment-shaped date range in the text.
 *
 * `now` is passed in rather than read from the clock so the result is a
 * function of its inputs and a test can say what "Present" means.
 */
export function experienceRanges(text: string, now = new Date()): ExperienceRange[] {
  const scannable = proseOnly(text);
  const nowMonth = now.getFullYear() * 12 + now.getMonth();
  const out: ExperienceRange[] = [];
  for (const m of scannable.matchAll(RANGE)) {
    const startYear = Number(m[2]);
    const startMonth = monthIndex(m[1]);
    // A range with no month starts at the beginning of its year and ends at
    // the end of the end year: "2021 - 2024" is three years, not two.
    const start = absMonth(startYear, startMonth, 0);
    let end: number;
    let ongoing = false;
    if (m[3]) {
      ongoing = true;
      end = nowMonth;
    } else {
      const raw = m[5];
      // "2017 - 18" means 2018, in the start's century.
      const endYear = raw.length === 2
        ? Math.floor(startYear / 100) * 100 + Number(raw)
        : Number(raw);
      const endMonthWord = monthIndex(m[4]);
      end = absMonth(endYear, endMonthWord, 11);
    }
    // A CV that dates a role into the future is either mistaken or listing a
    // contract end; either way nobody has worked months that have not happened.
    if (end > nowMonth) end = nowMonth;
    if (end < start) continue;
    if (start < 1950 * 12) continue;
    out.push({ startMonth: start, endMonth: end, ongoing });
  }
  return out;
}

/** Merge overlapping and adjacent ranges, so a promotion is not counted twice. */
export function mergeRanges(ranges: readonly ExperienceRange[]): ExperienceRange[] {
  const sorted = [...ranges].sort((a, b) => a.startMonth - b.startMonth);
  const merged: ExperienceRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    // Adjacent months join: leaving one job in June and starting the next in
    // July is not a career break.
    if (last && r.startMonth <= last.endMonth + 1) {
      merged[merged.length - 1] = {
        startMonth: last.startMonth,
        endMonth: Math.max(last.endMonth, r.endMonth),
        ongoing: last.ongoing || r.ongoing,
      };
    } else {
      merged.push(r);
    }
  }
  return merged;
}

/** Longest a career can be before the number says more about the parser than the candidate. */
const MAX_YEARS = 45;

/**
 * Years of experience, or undefined where the CV writes no range at all.
 *
 * Rounded to the nearest year, with a floor of 1 for anyone who has worked at
 * all: "0 yrs experience" on a CV listing a job reads as a parser failure,
 * which it would be.
 */
export function totalExperienceYears(text: string, now = new Date()): number | undefined {
  const merged = mergeRanges(experienceRanges(text, now));
  if (!merged.length) return undefined;
  const months = merged.reduce((sum, r) => sum + (r.endMonth - r.startMonth + 1), 0);
  // Truncated, not rounded. Twenty-two years and nine months is what a person
  // calls twenty-two years of experience; rounding up claims a year they have
  // not worked, on the figure that sets the level they are interviewed at.
  const years = Math.floor(months / 12);
  return Math.min(MAX_YEARS, Math.max(1, years));
}
