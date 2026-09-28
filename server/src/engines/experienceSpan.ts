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
 *
 * WHAT A DATE RANGE IS no longer lives here. It lives in domain/cvDates.ts,
 * which the role reader in engines/cvFacts.ts also calls, because the two used
 * to be separate regexes with separate vocabularies: a timeline strip reading
 * "2017 - 18" added to this total while producing no role at all, and a German
 * CV whose current job ran "01.03.2021 – heute" contributed to neither. What
 * stays here is this module's POLICY — mask what is not prose, clamp the
 * future, refuse anything before 1950, and add the union rather than the span.
 */

import { findDateRanges, looksLikeCareerBreak } from '../domain/cvDates.js';

export interface ExperienceRange {
  /** Months since year 0, so arithmetic needs no calendar. */
  readonly startMonth: number;
  readonly endMonth: number;
  /** The range had no end date: "2019 - Present". */
  readonly ongoing: boolean;
}

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

/**
 * The longest run of text scanned as one piece.
 *
 * Every pattern here can backtrack, and backtracking cost grows faster than
 * the length of the unbroken run it is working on. The input is a CV, which
 * an attacker supplies: 200,000 characters of "1" — the extraction cap, on
 * one line — took 78 seconds of CPU, and 200,000 dashes took 75. That is a
 * denial of service against a public upload endpoint, one file at a time.
 *
 * A real CV line runs to a few hundred characters; a date range and a phone
 * number are both far shorter. Nothing legitimate is lost by refusing to
 * treat a 200,000-character run as a single line, and capping it turns the
 * worst case linear in the size of the document.
 */
const MAX_SCAN_RUN = 2000;

/** Long runs split into scannable pieces, at a space where there is one. */
function scannableRuns(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= MAX_SCAN_RUN) { out.push(line); continue; }
    for (let i = 0; i < line.length; i += MAX_SCAN_RUN) {
      // Overlap each piece with the last, so a range sitting on a boundary is
      // still read whole.
      out.push(line.slice(Math.max(0, i - 40), i + MAX_SCAN_RUN));
    }
  }
  return out;
}

function maskRun(run: string): string {
  let out = run.replace(VERSIONED_PRODUCT, (m) => ' '.repeat(m.length));
  for (const re of NOT_PROSE) out = out.replace(re, (m) => ' '.repeat(m.length));
  return out;
}

/**
 * Blank out anything a date cannot legitimately be found inside.
 *
 * Chunked for the same reason as the scan above, and length-preserving, so
 * every character keeps its position. Nothing this masks — an email, a URL, a
 * phone number, a product version — is ever written across a line break, so
 * chunking costs no coverage in any real document.
 */
export function proseOnly(text: string): string {
  if (text.length <= MAX_SCAN_RUN) return maskRun(text);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_SCAN_RUN) out.push(maskRun(text.slice(i, i + MAX_SCAN_RUN)));
  return out.join('');
}

/**
 * A point on the calendar as a month count. `fallback` is where a date that
 * named no month sits: the start of its year at one end of a range, the end of
 * it at the other, so "2021 - 2024" is three years and not two.
 *
 * `cvDates` numbers months 1-12 the way a person writes them; this file counts
 * from 0 so the arithmetic needs no calendar.
 */
function absMonth(year: number, month: number | null, fallback: number): number {
  return year * 12 + (month === null ? fallback : month - 1);
}

/**
 * Every employment-shaped date range in the text.
 *
 * `now` is passed in rather than read from the clock so the result is a
 * function of its inputs and a test can say what "Present" means.
 */
export function experienceRanges(text: string, now = new Date()): ExperienceRange[] {
  const nowMonth = now.getFullYear() * 12 + now.getMonth();
  const out: ExperienceRange[] = [];
  for (const run of scannableRuns(text)) {
    out.push(...rangesInRun(run, nowMonth));
  }
  return out;
}

function rangesInRun(run: string, nowMonth: number): ExperienceRange[] {
  // A break the candidate wrote down is not work. Whole-line, because the
  // dates and the words that make it a break sit on the same line and masking
  // only the words would leave the range behind to be counted anyway.
  if (looksLikeCareerBreak(run)) return [];
  const scannable = proseOnly(run);
  const out: ExperienceRange[] = [];
  for (const range of findDateRanges(scannable)) {
    const start = absMonth(range.start.year, range.start.month, 0);
    let end = range.ongoing ? nowMonth : absMonth(range.end!.year, range.end!.month, 11);
    // A CV that dates a role into the future is either mistaken or listing a
    // contract end; either way nobody has worked months that have not happened.
    if (end > nowMonth) end = nowMonth;
    if (end < start) continue;
    if (start < 1950 * 12) continue;
    out.push({ startMonth: start, endMonth: end, ongoing: range.ongoing });
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
