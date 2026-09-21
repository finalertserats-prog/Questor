import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A bare toLocaleString() on a date writes it on the viewer's clock with no
 * zone named, in whatever format the browser picks. dateFormat.ts exists to
 * stop that; this keeps new ones from creeping back in.
 */

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const BARE_DATE = /new Date\([^)]*\)\.toLocale(Date|Time)?String\(\)/;

describe('dates in the console', () => {
  it('never print a date with a bare toLocaleString', () => {
    const hits = sourceFiles(SRC).flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((text, index) => (
      BARE_DATE.test(text) ? [`${relative(SRC, file)}:${index + 1}`] : []
    )));
    expect(hits).toEqual([]);
  });
});
