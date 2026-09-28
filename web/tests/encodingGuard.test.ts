import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A build once wrote source files through a shell redirect that was not
 * UTF-8, and every '·', '—' and '×' in them became '?' (or U+FFFD). The page
 * still compiled, so nothing failed: people just read "Senior ? IN" and a
 * remove button labelled "React ?". These checks fail the suite instead.
 */

const SRC = join(__dirname, '..', 'src');
const SCANNED = /\.(tsx?|css|html)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : SCANNED.test(name) ? [path] : [];
  });
}

interface Hit { readonly file: string; readonly line: number; readonly text: string }

function findLines(pattern: RegExp, files: readonly string[]): Hit[] {
  return files.flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((text, index) => (
    pattern.test(text) ? [{ file: relative(SRC, file), line: index + 1, text: text.trim() }] : []
  )));
}

const files = sourceFiles(SRC);
const tsx = files.filter((f) => f.endsWith('.tsx'));

describe('source encoding', () => {
  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('contains no U+FFFD replacement character', () => {
    const replacement = Buffer.from([0xef, 0xbf, 0xbd]);
    const damaged = files.filter((file) => readFileSync(file).includes(replacement)).map((f) => relative(SRC, f));
    expect(damaged).toEqual([]);
  });

  // JSX text ending in " ?" right before a closing tag: "{t} ?</button>".
  // A ternary is "? <Tag", never "? </Tag", so this cannot hit real code.
  it('has no JSX text that ends in a stray " ?"', () => {
    expect(findLines(/\S \?\s*<\//, tsx)).toEqual([]);
  });

  // A string that starts with " ? " where a separator belonged: ` ? Region: …`.
  it('has no template string opening with a " ? " separator', () => {
    expect(findLines(/`\s\?\s[A-Za-z$]/, files)).toEqual([]);
  });

  it('never joins display text with " ? "', () => {
    expect(findLines(/join\(\s*['"`]\s*\?\s*['"`]\s*\)/, files)).toEqual([]);
  });

  // A shown value falling back to a bare '?' where a dash belonged.
  it('never falls back to a bare "?" for a displayed value', () => {
    expect(findLines(/=\{[^}]*(\|\||\?\?)\s*['"`]\?['"`]\s*\}/, tsx)).toEqual([]);
  });
});
