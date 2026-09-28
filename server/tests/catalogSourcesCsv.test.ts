import { describe, expect, it } from 'vitest';
import { csvObjects, parseCsv } from '../src/services/catalogSources/csv.js';

/**
 * O*NET ships its tables as CSV with quoted descriptions that contain commas,
 * doubled quotes and, now and then, line breaks. A naive split would shift
 * every later column and file a description under "Title".
 */
describe('parseCsv', () => {
  it('keeps a comma inside a quoted field', () => {
    expect(parseCsv('a,"one, two"\n')).toEqual([['a', 'one, two']]);
  });

  it('turns a doubled quote into one quote', () => {
    expect(parseCsv('"say ""hi"""\n')).toEqual([['say "hi"']]);
  });

  it('keeps a line break inside a quoted field', () => {
    expect(parseCsv('"multi\nline",x\n')).toEqual([['multi\nline', 'x']]);
  });

  it('reads CRLF line endings as row ends', () => {
    expect(parseCsv('a,b\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c,\n')).toEqual([['a', '', 'c', '']]);
  });

  it('reads a last row that has no line ending', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('returns no rows for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('refuses a file whose quoted field never closes', () => {
    expect(() => parseCsv('a,"never closed\n')).toThrow(/unterminated/i);
  });
});

describe('csvObjects', () => {
  it('keys each row by the header, ignoring a byte order mark', () => {
    const byteOrderMark = String.fromCharCode(0xfeff);
    expect(csvObjects(`${byteOrderMark}O*NET-SOC Code,Title\n11-1011.00,Chief Executives\n`)).toEqual([{ 'O*NET-SOC Code': '11-1011.00', Title: 'Chief Executives' }]);
  });

  it('fills a missing trailing cell with an empty string', () => {
    expect(csvObjects('a,b\n1\n')).toEqual([{ a: '1', b: '' }]);
  });

  it('skips blank lines', () => {
    expect(csvObjects('a\n1\n\n2\n')).toEqual([{ a: '1' }, { a: '2' }]);
  });
});
