/**
 * Turning a PDF's glyphs back into lines a reader would recognise.
 *
 * pdf-parse's own renderer concatenates a page's text items in the order the
 * file happens to store them, with no separator. On a real CV that is not a
 * cosmetic problem, it is a correctness one. Two failures from the same
 * afternoon, both from CVs uploaded to production:
 *
 * - A career-timeline strip drew "2017 - 18", "2021 - 22", "2022 - 25" and
 *   "2025 - 26" side by side at the same height. Concatenated, they came back
 *   as "182021 - 222022 - 252025 - 26", and the parser stored that as the
 *   candidate's employer.
 * - A two-column CV put work history on the left and the skills list on the
 *   right. Read straight through, every job title arrived welded to an
 *   unrelated line of tooling: "Marketing Manager — Recur Club   Performance &
 *   Paid Media: Google Ads, ...".
 *
 * So we render pages ourselves from the text items' own coordinates: group
 * them into lines by baseline, order each line by x, insert a separator where
 * the horizontal gap says one belongs, and — where the page really is in
 * columns — read each column through before starting the next.
 *
 * This is layout reconstruction, not layout understanding. It is deliberately
 * conservative: every rule below falls back to the single-column reading when
 * the evidence for a column is not clear, because merging two columns is a
 * visible mess a person can still read, while splitting a page that was never
 * in columns silently reorders a sentence.
 */

/** One text item as pdf.js reports it: a string and where it sits on the page. */
export interface TextItem {
  readonly str: string;
  /** pdf.js transform matrix; [4] is x and [5] is the baseline y. */
  readonly transform: readonly number[];
  readonly width?: number;
  readonly height?: number;
}

interface Piece {
  readonly s: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Items closer than this in baseline y are the same line, before font size is considered. */
const LINE_TOLERANCE_PT = 2;

/**
 * A gap wide enough to be a column gutter rather than word spacing. Word gaps
 * in body text run to about 4pt at 10pt type; tab stops and table cells run
 * wider. 24pt is above anything justification produces and below the gutter of
 * every two-column CV template we have seen.
 */
const GUTTER_MIN_PT = 24;

/** Below this share of lines respecting it, a gap is a coincidence, not a gutter. */
const GUTTER_MIN_SHARE = 0.55;

/** A column needs this many lines of its own before we believe in it. */
const GUTTER_MIN_LINES = 4;

/**
 * The thinner side of a real gutter still carries at least this share of the
 * thicker side's text. Below it, the "column" is a margin note or a date
 * column, not a column.
 */
const GUTTER_MIN_MASS = 0.25;

/**
 * Some PDFs encode their spaces as tabs — the two CVs above both did, which is
 * why "JATIN\tKUMAR" reached the parser. A tab inside a text item is a space
 * that was written oddly, never structure, because structure in a PDF is
 * position and position is what we read instead.
 */
function cleanItemText(raw: string): string {
  return raw.replace(/[\t   ]/g, ' ').replace(/[​-‍﻿]/g, '');
}

function toPieces(items: readonly TextItem[]): Piece[] {
  const out: Piece[] = [];
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const s = cleanItemText(it.str);
    if (!s.trim()) continue;
    const x = Number(it.transform?.[4]);
    const y = Number(it.transform?.[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const w = Number.isFinite(it.width) ? Number(it.width) : s.length * 4;
    const h = Number.isFinite(it.height) && Number(it.height) > 0 ? Number(it.height) : 10;
    out.push({ s, x, y, w, h });
  }
  return out;
}

/** Group pieces sharing a baseline, top of the page first. */
function groupIntoLines(pieces: readonly Piece[]): Piece[][] {
  const sorted = [...pieces].sort((a, b) => (Math.abs(a.y - b.y) > LINE_TOLERANCE_PT ? b.y - a.y : a.x - b.x));
  const lines: Piece[][] = [];
  let current: Piece[] = [];
  let baseline: number | null = null;
  for (const piece of sorted) {
    // Half the glyph height, so a superscript or a slightly raised bullet stays
    // on its line while the next line down starts a new one.
    const tolerance = Math.max(LINE_TOLERANCE_PT, piece.h * 0.5);
    if (baseline === null || Math.abs(piece.y - baseline) <= tolerance) {
      current.push(piece);
      if (baseline === null) baseline = piece.y;
    } else {
      lines.push(current);
      current = [piece];
      baseline = piece.y;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

/**
 * The x a page is split at, or null for a page that is not in columns.
 *
 * A gutter has to be a vertical band that almost every line leaves empty while
 * having text on both sides of it often enough to be a column rather than an
 * indent. Both halves of that test matter: a page of centred headings leaves
 * the margins empty without being in columns, and a hanging indent puts text
 * on both sides of a gap that no line respects.
 */
export function findGutter(lines: readonly Piece[][]): number | null {
  const spans = lines.map((line) => {
    const sorted = [...line].sort((a, b) => a.x - b.x);
    return { left: sorted[0].x, right: Math.max(...sorted.map((p) => p.x + p.w)), pieces: sorted };
  });
  if (spans.length < GUTTER_MIN_LINES * 2) return null;

  // Candidates are the gaps the page actually contains, not a blind scan.
  const candidates = new Set<number>();
  for (const span of spans) {
    for (let i = 1; i < span.pieces.length; i++) {
      const gap = span.pieces[i].x - (span.pieces[i - 1].x + span.pieces[i - 1].w);
      if (gap >= GUTTER_MIN_PT) candidates.add(span.pieces[i - 1].x + span.pieces[i - 1].w + gap / 2);
    }
  }
  if (!candidates.size) return null;

  let best: { x: number; score: number } | null = null;
  for (const x of candidates) {
    let straddling = 0;
    let bothSides = 0;
    let leftOnly = 0;
    let rightOnly = 0;
    let leftChars = 0;
    let rightChars = 0;
    for (const span of spans) {
      // A line straddles the gutter only if a single piece crosses it; a line
      // with a piece each side is exactly what a two-column row looks like.
      const crosses = span.pieces.some((p) => p.x < x - 1 && p.x + p.w > x + 1);
      if (crosses) { straddling += 1; continue; }
      const hasLeft = span.pieces.some((p) => p.x + p.w <= x);
      const hasRight = span.pieces.some((p) => p.x >= x);
      for (const p of span.pieces) {
        if (p.x + p.w <= x) leftChars += p.s.trim().length;
        else if (p.x >= x) rightChars += p.s.trim().length;
      }
      if (hasLeft && hasRight) bothSides += 1;
      else if (hasLeft) leftOnly += 1;
      else if (hasRight) rightOnly += 1;
    }
    const respecting = spans.length - straddling;
    if (respecting / spans.length < GUTTER_MIN_SHARE) continue;
    if (bothSides < GUTTER_MIN_LINES) continue;
    // Both columns must carry content of their own. A gutter with nothing but
    // paired rows is a table, and a table reads correctly left to right.
    if (leftOnly + bothSides < GUTTER_MIN_LINES || rightOnly + bothSides < GUTTER_MIN_LINES) continue;
    // And both must carry a comparable amount of it. This is what tells a
    // second column from a right-aligned date column, which is the commonest
    // CV layout there is: every role line has "2018 - 2021" at the right
    // margin, so the paired-row test above passes perfectly, and splitting
    // there would lift every date away from the job it belongs to and stack
    // them at the end of the section. A date column carries a tenth of the
    // text of the column beside it; a real second column carries a third or
    // more.
    if (Math.min(leftChars, rightChars) < Math.max(leftChars, rightChars) * GUTTER_MIN_MASS) continue;
    const score = bothSides + respecting;
    if (!best || score > best.score) best = { x, score };
  }
  return best ? best.x : null;
}

function renderLine(pieces: readonly Piece[]): string {
  const sorted = [...pieces].sort((a, b) => a.x - b.x);
  let out = '';
  let prevEnd: number | null = null;
  for (const piece of sorted) {
    if (prevEnd !== null) {
      const gap = piece.x - prevEnd;
      // A gap the width of a space is a space; a wider one is a cell boundary,
      // and marking it keeps "2017 - 18" and "2021 - 22" from fusing.
      if (gap >= GUTTER_MIN_PT / 2) out += '   ';
      else if (gap > 0.8 && !/\s$/.test(out) && !/^\s/.test(piece.s)) out += ' ';
    }
    out += piece.s;
    prevEnd = piece.x + piece.w;
  }
  return out.replace(/ {4,}/g, '   ').trim();
}

/**
 * Read a page in blocks: a run of lines that all sit on one side of the gutter
 * is a column block, read left column through and then right; a line that
 * crosses the gutter is full width and ends the block it interrupts.
 *
 * Reading the whole page as two columns instead would be simpler and wrong —
 * CVs routinely put a full-width name, summary and section rule above a
 * two-column body, and those lines belong where they were written.
 */
function renderColumns(lines: readonly Piece[][], gutter: number): string[] {
  const out: string[] = [];
  let left: string[] = [];
  let right: string[] = [];
  const flush = () => {
    out.push(...left, ...right);
    left = [];
    right = [];
  };
  for (const line of lines) {
    const crosses = line.some((p) => p.x < gutter - 1 && p.x + p.w > gutter + 1);
    if (crosses) {
      flush();
      out.push(renderLine(line));
      continue;
    }
    const leftPieces = line.filter((p) => p.x + p.w <= gutter);
    const rightPieces = line.filter((p) => p.x >= gutter);
    if (leftPieces.length) left.push(renderLine(leftPieces));
    if (rightPieces.length) right.push(renderLine(rightPieces));
  }
  flush();
  return out;
}

/** The page's text, as lines, from its items' own coordinates. */
export function renderTextItems(items: readonly TextItem[]): string {
  const pieces = toPieces(items);
  if (!pieces.length) return '';
  const lines = groupIntoLines(pieces);
  const gutter = findGutter(lines);
  const rendered = gutter === null ? lines.map(renderLine) : renderColumns(lines, gutter);
  return rendered.filter((l) => l.length > 0).join('\n');
}

/**
 * A page renderer for pdf-parse, and a count of the pages it could not read.
 *
 * One renderer per document, because the count belongs to that document and
 * two uploads can be in flight at once.
 *
 * The count exists because a lost page is invisible otherwise. pdf-parse wraps
 * the renderer in `.catch(() => "")` of its own, so a page that fails to read
 * contributes nothing and the parse still reports success — a three-page job
 * advert whose second page fails comes through as a perfectly plausible job
 * description with its requirements missing, and a scorecard is then built
 * confidently on half an advert, every extracted competency properly cited
 * from the half that survived. Nothing looks wrong. That is worse than the
 * scanned-PDF case, which at least produces nothing at all.
 *
 * So the caller asks afterwards, and refuses a document that lost a page
 * rather than working from what is left.
 */
export interface PdfRead {
  readonly render: (page: { getTextContent: (opts: Record<string, boolean>) => Promise<{ items: TextItem[] }> }) => Promise<string>;
  /** Pages whose text could not be read at all. */
  failedPages: () => number;
}

export function pdfRead(): PdfRead {
  let failed = 0;
  return {
    failedPages: () => failed,
    render: (page) => page
      .getTextContent({ normalizeWhitespace: false })
      .then((content) => {
        try {
          const laid = renderTextItems(content.items);
          if (laid.trim()) return laid;
        } catch {
          // A page we cannot lay out is still a page we can read: fall back to
          // the plain reading rather than losing it.
        }
        return content.items.map((it) => cleanItemText(String(it?.str ?? ''))).join(' ').trim();
      })
      .catch(() => {
        failed += 1;
        return '';
      }),
  };
}
