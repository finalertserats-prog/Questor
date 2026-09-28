/**
 * How a CV writes a date range — one grammar, read by everything.
 *
 * There were two. `engines/cvFacts.ts` had `parseDateRange`, which builds the
 * candidate's ROLES, and `engines/experienceSpan.ts` had its own `RANGE`,
 * which builds the YEARS OF EXPERIENCE printed on their profile and fed to
 * band calibration. They disagreed, and the disagreement was recorded in a
 * test rather than fixed: a timeline strip reading "2017 - 18" added to the
 * years total while producing no role at all, so a candidate had experience
 * the screen could not account for.
 *
 * Both were also English-only, which is the larger failure. A CV is written in
 * the language its author works in. A German engineer whose current job runs
 * "01.03.2021 – heute" had that job read as nothing: `heute` is not `present`,
 * the range did not parse, the line was not a role heading, and eight years of
 * career were reported as three years and seven months — on the number that
 * decides how hard their interview is pitched. The same hole was open for
 * `aujourd'hui`, `actualidad`, `hoje`, `oggi` and `heden`, and for every month
 * name outside English.
 *
 * So: one vocabulary, covering the languages Questor's CVs actually arrive in,
 * and one range matcher both engines call. What each engine then DOES with a
 * range stays where it was — experienceSpan still masks phone numbers and
 * clamps the future, cvFacts still decides what counts as a role. Shared
 * grammar, separate policy.
 */

/**
 * Month names as CVs write them: English, German, French, Spanish,
 * Portuguese, Italian and Dutch, in full and in the three-letter form.
 *
 * Written as an explicit alternation rather than `(jan|feb|...)[a-z]*`. The
 * loose form matched "Marketing 2019" as March, because `mar` plus any letters
 * is most of a dictionary. Here the letters after the stem are enumerated, so
 * a word that merely starts like a month cannot pass.
 */
const MONTH_WORD =
  '(?:jan(?:uary|uar|vier|uari|eiro)?|ene(?:ro)?|gen(?:naio)?'
  + '|feb(?:ruary|ruar|braio|rero|reiro|ruari)?|f[ée]v(?:rier|ereiro)?'
  + '|mar(?:ch|zo|ço|s|zec)?|m[äa]rz|maart|mrz'
  + '|apr(?:il|ile)?|avr(?:il)?|abr(?:il)?'
  + '|may|mayo|mai(?:o)?|mag(?:gio)?|mei'
  + '|juin|jun(?:e|i|io|ho)?|giu(?:gno)?'
  + '|juil(?:let)?|jul(?:y|i|io|ho)?|lug(?:lio)?'
  + '|aug(?:ust|ustus)?|ao[ûu]t|ago(?:sto)?'
  // `sett.` is how an Italian CV abbreviates September, and it has to be
  // spelled out here: the stem table knows `sett` but the pattern only
  // offered `set`, so `sett. 2020 - ott. 2021` parsed as a range whose start
  // month was simply lost.
  + '|sept(?:ember|embre|iembre|embro)?|sep|set(?:t(?:embre)?|embro|iembre)?'
  + '|oct(?:ober|obre|ubre)?|okt(?:ober)?|ott(?:obre)?|out(?:ubro)?'
  + '|nov(?:ember|embre|iembre|embro)?'
  + '|dec(?:ember|embre)?|d[ée]c(?:embre)?|dez(?:ember|embro)?|dic(?:iembre|embre)?)\\.?';

/**
 * Stem to month, 1-based. Looked up four letters first, then three, because
 * French `juin` (June) and `juillet` (July) share their first three.
 */
const MONTH_BY_STEM: Readonly<Record<string, number>> = {
  juin: 6, juil: 7, sett: 9, mrz: 3, maar: 3,
  jan: 1, ene: 1, gen: 1,
  feb: 2, fev: 2,
  mar: 3, maa: 3,
  apr: 4, avr: 4, abr: 4,
  may: 5, mai: 5, mag: 5, mei: 5,
  jun: 6, giu: 6,
  jul: 7, lug: 7,
  aug: 8, aou: 8, ago: 8,
  sep: 9, set: 9,
  oct: 10, okt: 10, ott: 10, out: 10,
  nov: 11,
  dec: 12, dez: 12, dic: 12,
};

/** Diacritics off before the stem lookup, so `février` and `märz` land on `fev` and `mar`. */
const plain = (word: string) => word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The month a written month name means, or null. */
export function monthFromWord(word: string | undefined): number | null {
  if (!word) return null;
  const key = plain(word).replace(/\./g, '');
  return MONTH_BY_STEM[key.slice(0, 4)] ?? MONTH_BY_STEM[key.slice(0, 3)] ?? null;
}

/**
 * "This job has not ended", in the languages CVs say it in.
 *
 * The trailing boundary is not optional and never was: without it `present`
 * matched inside "presently", `now` inside "nowhere", and bare `date` inside
 * "dated" — so "Engineer, Acme 2019 - dates vary" became a role still running
 * today.
 *
 * Two words are deliberately NOT in this list, and a third deliberately is.
 *
 * Bare `actual` is out. It is Spanish and Portuguese for "current", but it is
 * also an ordinary English word in the exact position a CV puts it: "Budget
 * 2019 - actual vs forecast" read as a job still running today, on a finance
 * CV where that sentence is unremarkable. `actualmente` and `actualidad` are
 * what Spanish CVs actually write here, and they are unambiguous.
 *
 * Bare Dutch `nu` is out for the same reason and a weaker justification —
 * two letters, and `heden` covers the same CVs.
 *
 * Bare `date` stays, and it is load-bearing: "Consultant 2019 to date" spends
 * its "to" on the dash and leaves `date` alone on the far side. The cost is
 * that "2020 - date TBD" reads as ongoing. That is a pre-existing false
 * positive, it is narrow, and removing the word would lose a common real
 * shape to prevent an uncommon fake one.
 */
const ONGOING =
  '(?:presente|pr[ée]sente|pr[ée]sent|present|currently|current|actualmente|actualidad'
  + '|atualmente|atual|now|jetzt|derzeit|heute|heden|huidig|hoje|hoy|oggi'
  + '|aujourd[\'’]?\\s?hui|ce\\s+jour|en\\s+cours|in\\s+corso|ad\\s+oggi'
  + '|aktuell|laufend|gegenw[äa]rtig|attualmente|attuale'
  + '|to\\s*date|till\\s*date|ongoing|date)(?![a-zà-ÿ])';

/**
 * What sits between the two ends of a range.
 *
 * Symbol dashes may touch the dates; word dashes must be surrounded by space,
 * or Spanish `a` and French `à` would split numbers that are not a range at
 * all.
 */
const DASH =
  '(?:\\s*[-–—~→]\\s*'
  + '|\\s+(?:to|through|until|till|bis(?:\\s+zum)?|zum|hasta|at[ée]|jusqu[\'’]?\\s*[àa]|fino\\s+al?|au|[àa])\\s+)';

/**
 * A four-digit year, and not four digits inside a longer number.
 *
 * Without the boundaries a year could be taken out of the middle of any digit
 * run: "Invoice 992019 - 2022 paid" read as three years of employment, and a
 * CV is full of numbers that are not dates — order references, ID numbers,
 * postcodes, part codes. `experienceSpan` masks the worst of them before
 * scanning; the role reader does not, and now does not need to.
 */
const YEAR = '(?<!\\d)(?:19|20)\\d{2}(?!\\d)';
/** Boundary-free, for the cheap pre-gate below, where a false yes costs nothing. */
const YEAR_LOOSE = '(?:19|20)\\d{2}';
/** Not preceded by a letter, so `mar` inside "Amara" cannot start a month. */
const NOT_AFTER_LETTER = '(?<![a-zà-ÿA-ZÀ-Ÿ])';

/**
 * One end of a range, in the three shapes CVs write:
 *   "March 2021" / "Januar 2019" / "septiembre 2020"
 *   "01.03.2021" / "03/2021"  — day-first where a day is present
 *   "2021"
 *
 * The day-first reading is deliberate. Where both leading numbers could be a
 * day or a month the date is genuinely ambiguous, and it is read day-first
 * because that is how most of Europe and India write one. The YEAR — which is
 * what tenure and band calibration are computed from — is right either way.
 */
function point(prefix: string): string {
  return '(?:'
    + `${NOT_AFTER_LETTER}(?<${prefix}Word>${MONTH_WORD})[\\s.,/-]*(?<${prefix}WordYear>${YEAR})`
    + `|(?:(?<${prefix}Day>\\d{1,2})[./-])?(?<${prefix}Num>\\d{1,2})[./-](?<${prefix}NumYear>${YEAR})`
    + `|(?<${prefix}Year>${YEAR})`
    + ')';
}

/**
 * A whole range. The two-digit end ("2017 - 18") is last, so it is only
 * reached when nothing else fits; it is common on timeline strips and is read
 * as the same century as its start.
 */
const RANGE_SOURCE = `${point('s')}${DASH}(?:(?<ongoing>${ONGOING})|${point('e')}|(?<eShort>\\d{2})(?!\\d))`;

export interface CvDatePoint {
  readonly year: number;
  /** 1-12, or null where the CV wrote only a year. */
  readonly month: number | null;
}

export interface CvDateRange {
  /** Where the match starts in the text it was found in. */
  readonly index: number;
  /** Exactly the characters matched, so a caller can blank them out. */
  readonly text: string;
  readonly start: CvDatePoint;
  /** null when the range is open — the job is still running. */
  readonly end: CvDatePoint | null;
  readonly ongoing: boolean;
}

/** Fresh each call: a global regex carries `lastIndex` between callers. */
const rangeRe = (flags = 'gi') => new RegExp(RANGE_SOURCE, flags);

type Groups = Record<string, string | undefined>;

function pointFrom(g: Groups, prefix: string): CvDatePoint | null {
  const word = g[`${prefix}Word`];
  const wordYear = g[`${prefix}WordYear`];
  if (word && wordYear) return { year: Number(wordYear), month: monthFromWord(word) };
  const num = g[`${prefix}Num`];
  const numYear = g[`${prefix}NumYear`];
  if (num && numYear) {
    // With a day in front, the second number is the month. Without one, the
    // single number is the month: "03/2021" is March, not the third of a year.
    const month = Math.min(12, Math.max(1, Number(num)));
    return { year: Number(numYear), month };
  }
  const bare = g[`${prefix}Year`];
  return bare ? { year: Number(bare), month: null } : null;
}

/**
 * "2017 - 18" means 2018. Taking the start's century outright breaks across
 * one: "1998 - 02" becomes 1902, which ends before it starts and used to be
 * thrown away, losing the role. A two-digit end that lands before its start
 * belongs to the next century, because a range runs forwards.
 */
function shorthandYear(raw: string, startYear: number): number {
  const century = Math.floor(startYear / 100) * 100;
  const sameCentury = century + Number(raw);
  if (sameCentury >= startYear) return sameCentury;
  // Rolling forward is only right where it produces a career. "1998 - 02" is
  // 2002 and the role is four years long. "2019 - 18" is a typo or an OCR
  // slip, and rolling it gave 2118 — a ninety-nine-year job, clamped to today
  // by the years reader and counted as still running. Beyond a working life,
  // the shorthand is not a century boundary; it is a mistake, and the caller
  // rejects an end before its start.
  const rolled = sameCentury + 100;
  return rolled - startYear <= MAX_SHORTHAND_SPAN_YEARS ? rolled : sameCentury;
}

/** Longer than this and a rolled-over two-digit year is a typo, not a century. */
const MAX_SHORTHAND_SPAN_YEARS = 30;

/**
 * Cheap gate before the expensive one.
 *
 * A CV is a file a stranger uploads, and the range pattern is a sixty-branch
 * alternation that the engine tries at every position. No range can exist
 * without a four-digit year in it, and testing for one is a single linear
 * scan — so 200,000 characters of "1" or of "-" are refused in milliseconds
 * rather than being walked branch by branch.
 */
const HAS_YEAR = new RegExp(YEAR_LOOSE);

/** Every date range in the text, in the order they appear. */
export function findDateRanges(text: string): CvDateRange[] {
  if (!HAS_YEAR.test(text)) return [];
  const out: CvDateRange[] = [];
  for (const m of text.matchAll(rangeRe())) {
    const g = (m.groups ?? {}) as Groups;
    const start = pointFrom(g, 's');
    if (!start) continue;
    let end: CvDatePoint | null = null;
    const ongoing = Boolean(g.ongoing);
    if (!ongoing) {
      end = pointFrom(g, 'e');
      if (!end && g.eShort) end = { year: shorthandYear(g.eShort, start.year), month: null };
      if (!end) continue;
    }
    out.push({ index: m.index ?? 0, text: m[0], start, end, ongoing });
  }
  return out;
}

/** The first range in the text, or null. */
export function firstDateRange(text: string): CvDateRange | null {
  return findDateRanges(text)[0] ?? null;
}

/** The text with every range blanked, for callers separating a job title from its dates. */
export function stripDateRanges(text: string): string {
  return text.replace(rangeRe(), '');
}

/**
 * A line that is CARRYING a date range, whether or not the grammar above could
 * read it.
 *
 * Deliberately looser than the parser, and that is its whole job: the gap
 * between "lines that look dated" and "lines the parse used" is the measure of
 * what the reading missed, and a detector as strict as the parser would always
 * report zero.
 */
const DATE_LIKE = new RegExp(
  `(?<!\\d)${YEAR}(?:\\s*[-–—~→]\\s*|\\s+(?:to|until|till|bis|hasta|at[ée]|au|[àa])\\s+)`
  + `(?:${YEAR}|\\d{1,2}(?!\\d)|[a-zà-ÿ][a-zà-ÿ'’]{1,14})`,
  'i',
);

export function looksDated(text: string): boolean {
  return DATE_LIKE.test(text);
}

/**
 * A dated line whose second end is a WORD rather than a date — the shape of a
 * job that has not ended, in a language or spelling the vocabulary above does
 * not carry yet.
 *
 * This is what makes "we could not read a current role" a statement with a
 * reason behind it rather than a guess. Without it the flag would fire on
 * every CV whose last job genuinely ended, which is a flag on none of them.
 */
const OPEN_ENDED = new RegExp(
  `(?<!\\d)${YEAR}(?:\\s*[-–—~→]\\s*|\\s+(?:to|until|till|bis|hasta|at[ée]|au|[àa])\\s+)`
  + '[a-zà-ÿ][a-zà-ÿ\'’]{1,14}',
  'i',
);

export function looksOpenEnded(text: string): boolean {
  return OPEN_ENDED.test(text) && !findDateRanges(text).some((r) => !r.ongoing);
}

/**
 * A line the candidate wrote to say they were NOT working.
 *
 * It carries a date range like any other line, and both readers counted it as
 * employment: a CV declaring "Career break — Apr 2017 - Feb 2020" between two
 * jobs had the break merged into the career either side, and eleven years of
 * work were reported as fourteen. The module that computes the years total
 * says in its own contract that it must not count gaps; a gap the candidate
 * was honest enough to write down is the one it was counting.
 */
const CAREER_BREAK = new RegExp(
  '\\b(?:career\\s+break|sabbatical|ann[ée]e\\s+sabbatique|sabb?[áa]tico'
  + '|parental\\s+leave|maternity\\s+leave|paternity\\s+leave|cong[ée]\\s+parental'
  + '|elternzeit|auszeit|berufspause|excedencia|aspettativa'
  + '|gap\\s+year|career\\s+gap|time\\s+out\\s+of\\s+work|out\\s+of\\s+the\\s+workforce)\\b',
  'i',
);

export function looksLikeCareerBreak(text: string): boolean {
  return CAREER_BREAK.test(text);
}

export { MONTH_WORD as CV_MONTH_WORD, ONGOING as CV_ONGOING, RANGE_SOURCE as CV_RANGE_SOURCE };
