import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_BEATS } from '../src/components/demo/demoScript';

/**
 * Every element the demo spotlights is named by a `data-tour` anchor in the
 * page markup. A page change that drops one would not break the demo loudly:
 * the beat would be skipped in front of a prospect, and nobody would know
 * why. So the build breaks instead. The e2e run then walks the whole
 * tour against the real pages; this is the fast check that the markup still
 * carries the names.
 */

const SRC = resolve(import.meta.dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'demo' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const anchorsInMarkup = new Set(
  sourceFiles(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    const found: string[] = [];
    // Written straight on the element, or handed to one through its anchor
    // prop (the workflow diagram, the Banner).
    for (const m of text.matchAll(/(?:data-tour|tourAnchor|anchor)=(?:"([a-z0-9-]+)"|\{'([a-z0-9-]+)'\})/g)) found.push(m[1] ?? m[2]);
    // Named from a table: the landing tabs (`tour:`), the assessment parts (`1:`).
    for (const m of text.matchAll(/(?:\btour|\b[123]):\s*'([a-z0-9-]+)'/g)) found.push(m[1]);
    return found;
  }),
);

describe('the demo\'s anchors', () => {
  const anchored = DEMO_BEATS.filter((beat) => beat.anchor !== undefined);

  it('are each in the page markup, outside the demo\'s own code', () => {
    const missing = anchored.filter((beat) => !anchorsInMarkup.has(beat.anchor!)).map((beat) => `${beat.id} → ${beat.anchor}`);
    expect(missing).toEqual([]);
  });

  it('cover every beat but the welcome and the two closing cards', () => {
    expect(DEMO_BEATS.filter((beat) => beat.anchor === undefined).map((beat) => beat.id)).toEqual(['B01', 'B18', 'B19']);
  });
});
