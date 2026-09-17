import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RoleCreate } from '../src/pages/RoleCreate';

/**
 * A <label> that is not tied to its control is just styled text: a screen
 * reader announces the field with no name, clicking the caption does not focus
 * the field, and getByLabel in the end-to-end suite cannot find it.
 */

const SRC = join(import.meta.dirname, '../src');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

const CONTROL = /<(input|select|textarea)\b/;

/** `file:line` for every <label> that neither names a control nor wraps one. */
function unboundLabels(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(/<label\b[^>]*>/g)) {
    if (/\bhtmlFor=/.test(match[0])) continue;
    const start = (match.index ?? 0) + match[0].length;
    const inner = source.slice(start, source.indexOf('</label>', start));
    if (CONTROL.test(inner)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    found.push(`${relative(SRC, file).replace(/\\/g, '/')}:${line}`);
  }
  return found;
}

/**
 * The router's hooks warn that useLayoutEffect does nothing on the server; that
 * is expected here, where only the markup is under test.
 */
function renderRoleCreate(): string {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RoleCreate)));
  } finally {
    quiet.mockRestore();
  }
}

describe('form labels', () => {
  it('ties every label in the web app to a control', () => {
    expect(tsxFiles(SRC).flatMap(unboundLabels)).toEqual([]);
  });

  it('points every label on the new-role form at an element that exists', () => {
    const html = renderRoleCreate();
    const targets = [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]);
    const missing = targets.filter((id) => !html.includes(`id="${id}"`));
    expect({ labels: targets.length, missing }).toEqual({ labels: 2, missing: [] });
  });

  it('names the new-role fields by their visible captions', () => {
    const html = renderRoleCreate();
    const jd = html.match(/<label for="([^"]+)">Job description<\/label>/);
    expect(jd && new RegExp(`<textarea[^>]*id="${jd[1]}"`).test(html)).toBe(true);
  });
});
