/**
 * CSV that a spreadsheet opens as data, never as a program.
 *
 * Lifted out of routes/interviews.ts when a second export needed it. A copy of
 * this rule is a copy that can drift, and the failure mode of the drifted copy
 * is a formula running on the reader's machine.
 */

/**
 * One CSV cell. A value starting with =, +, -, @, tab or CR is prefixed with an
 * apostrophe so a spreadsheet opens it as text rather than running it as a
 * formula; values containing quotes, commas or newlines are quoted.
 */
export function csvCell(value: string): string {
  const defused = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(defused) ? `"${defused.replace(/"/g, '""')}"` : defused;
}

/** One row. Numbers are written as numbers; null is an empty cell, not the word "null". */
export function csvRow(cells: ReadonlyArray<string | number | null>): string {
  return cells.map((cell) => (cell === null ? '' : csvCell(String(cell)))).join(',');
}

/** A whole document, newline-terminated so the last row is a row. */
export function csvDocument(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return `${rows.map(csvRow).join('\n')}\n`;
}
