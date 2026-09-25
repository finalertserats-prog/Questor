import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every stylesheet is loaded on every page, so a class name defined in two of
 * them is one class. The pipeline panel's ".stage" once painted its light card
 * behind the interview room's dark ".stage", and candidates could not read the
 * names on screen. A top-level class belongs to one stylesheet.
 */

const STYLES = join(__dirname, '..', 'src', 'styles');

// Deliberate: polish.css refines .card, and .icon only sets flex behaviour.
const SHARED_ON_PURPOSE = new Set(['card', 'icon']);

function topLevelClasses(css: string): string[] {
  return [...css.matchAll(/^\.([a-zA-Z][\w-]*)\s*\{/gm)].map((m) => m[1]);
}

describe('stylesheet class ownership', () => {
  it('defines each top-level class in only one stylesheet', () => {
    const owners = new Map<string, string[]>();
    for (const file of readdirSync(STYLES).filter((name) => name.endsWith('.css'))) {
      for (const name of new Set(topLevelClasses(readFileSync(join(STYLES, file), 'utf8')))) {
        owners.set(name, [...(owners.get(name) ?? []), file]);
      }
    }

    const clashes = [...owners].filter(([name, files]) => files.length > 1 && !SHARED_ON_PURPOSE.has(name));

    expect(clashes).toEqual([]);
  });
});
