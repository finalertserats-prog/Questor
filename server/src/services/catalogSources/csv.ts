/**
 * A small RFC 4180 reader for the O*NET tables. Written here rather than
 * pulled in as a dependency: the files are plain comma-separated text, and the
 * only hard parts (quoted commas, doubled quotes, line breaks inside quotes)
 * fit in one loop that the tests pin down.
 */

const QUOTE = '"';
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

interface ParseState {
  readonly rows: string[][];
  row: string[];
  cell: string;
  quoted: boolean;
}

function endCell(state: ParseState): void {
  state.row = [...state.row, state.cell];
  state.cell = '';
}

function endRow(state: ParseState): void {
  endCell(state);
  state.rows.push(state.row);
  state.row = [];
}

/** Returns how many characters were consumed. */
function readQuoted(state: ParseState, text: string, i: number): number {
  const ch = text[i];
  if (ch !== QUOTE) {
    state.cell += ch;
    return 1;
  }
  if (text[i + 1] === QUOTE) {
    state.cell += QUOTE;
    return 2;
  }
  state.quoted = false;
  return 1;
}

function readPlain(state: ParseState, text: string, i: number): number {
  const ch = text[i];
  if (ch === QUOTE && state.cell === '') state.quoted = true;
  else if (ch === ',') endCell(state);
  else if (ch === '\n') endRow(state);
  else if (ch === '\r' && text[i + 1] === '\n') return 1;
  else state.cell += ch;
  return 1;
}

export function parseCsv(text: string): string[][] {
  const state: ParseState = { rows: [], row: [], cell: '', quoted: false };
  let i = 0;
  while (i < text.length) {
    i += state.quoted ? readQuoted(state, text, i) : readPlain(state, text, i);
  }
  // A missing closing quote would otherwise swallow the rest of the file into
  // one cell and every later occupation would silently disappear.
  if (state.quoted) throw new Error('Malformed CSV: unterminated quoted field.');
  if (state.cell !== '' || state.row.length > 0) endRow(state);
  return state.rows;
}

/** Rows keyed by the header line; blank lines are dropped. */
export function csvObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text);
  const header = rows[0] ?? [];
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim().length > 0))
    .map((row) => Object.fromEntries(header.map((name, index) => [name.trim(), row[index] ?? ''])));
}
