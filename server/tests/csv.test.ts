import { describe, expect, it } from 'vitest';
import { csvCell, csvDocument, csvRow } from '../src/services/csv.js';

/**
 * The one rule that keeps an export from running as a program on the reader's
 * machine. It lives in its own module so there is one copy of it; these are
 * its own tests, separate from any export that uses it.
 */

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('Backend Engineer')).toBe('Backend Engineer');
  });

  it.each(['=', '+', '-', '@', '\t'])('defuses a value beginning with %j', (lead) => {
    expect(csvCell(`${lead}SUM(A1:A9)`).startsWith("'")).toBe(true);
  });

  // CR and LF are defused the same way, then quoted by the rule below, so the
  // apostrophe sits just inside the opening quote rather than first in the cell.
  it.each(['\r', '\n'])('defuses a value beginning with %j before quoting it', (lead) => {
    expect(csvCell(`${lead}SUM(A1:A9)`).startsWith("\"'")).toBe(true);
  });

  it('quotes a value carrying a comma, so it stays one cell', () => {
    expect(csvCell('Engineer, Backend')).toBe('"Engineer, Backend"');
  });

  it('doubles an embedded quote rather than ending the cell on it', () => {
    expect(csvCell('the "senior" one')).toBe('"the ""senior"" one"');
  });

  it('defuses AND quotes a value that leads with a newline — quoting alone is not defusing', () => {
    // Quoted but unprefixed, the cell's SECOND line is what a spreadsheet parses.
    expect(csvCell('\n=cmd|/c calc')).toBe('"\'\n=cmd|/c calc"');
  });

  it('does not defuse a formula character that is not the first thing in the cell', () => {
    expect(csvCell('A=B')).toBe('A=B');
  });
});

describe('csvRow', () => {
  it('writes a number as a number', () => {
    expect(csvRow(['a', 1])).toBe('a,1');
  });

  it('writes null as an empty cell, not as the word', () => {
    expect(csvRow(['a', null])).toBe('a,');
  });
});

describe('csvDocument', () => {
  it('terminates the last row, so it is a row', () => {
    expect(csvDocument([['a'], ['b']])).toBe('a\nb\n');
  });
});
