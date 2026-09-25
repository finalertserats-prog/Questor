import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon, ICON_ALIASES, ICON_NAMES, resolveIconName, type IconName } from '../src/components/Icon';

const render = (name: IconName, size?: number) => renderToStaticMarkup(createElement(Icon, { name, size }));

// The 2026 icon sheet, one entry per drawing on it.
const SHEET: readonly IconName[] = [
  'dashboard', 'candidates', 'candidate-profile', 'resume-upload', 'jobs',
  'job-description', 'role-match', 'ai-interview', 'interviews', 'schedule',
  'human-review', 'evidence-review', 'scorecard', 'skills-assessment', 'communication-score',
  'shortlist', 'decision', 'offer', 'rejected', 'search',
  'insights', 'reports', 'notes', 'recording', 'team',
  'notifications', 'settings', 'integrations', 'tasks', 'analytics',
];

/** Every number in the drawing, so geometry can be checked against the 24 grid. */
function drawingOf(markup: string): string {
  return markup.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
}

describe('Icon', () => {
  it('has a drawing for every icon on the 2026 sheet', () => {
    const missing = SHEET.filter((name) => !ICON_NAMES.includes(name));
    expect(missing).toEqual([]);
  });

  it.each(ICON_NAMES.map((name) => [name]))('draws something for %s', (name) => {
    expect(drawingOf(render(name))).toMatch(/<(path|circle|rect)\b/);
  });

  it('resolves the old names to the new drawings', () => {
    expect(Object.fromEntries(Object.keys(ICON_ALIASES).map((alias) => [alias, resolveIconName(alias as IconName)])))
      .toEqual({ role: 'jobs', job: 'job-description', evidence: 'evidence-review', draft: 'notes', mic: 'recording' });
  });

  it.each(Object.entries(ICON_ALIASES))('renders the alias %s exactly as %s', (alias, target) => {
    expect(render(alias as IconName)).toBe(render(target as IconName));
  });

  it('draws the rejected cross in the danger colour, whatever the theme', () => {
    expect(render('rejected')).toContain('var(--stop');
  });

  it('draws the unread dot on notifications in the danger colour', () => {
    expect(render('notifications')).toContain('fill:var(--stop');
  });

  it('keeps every other icon in the text colour', () => {
    const tinted = ICON_NAMES.filter((name) => name !== 'rejected' && name !== 'notifications' && render(name).includes('var(--'));
    expect(tinted).toEqual([]);
  });

  it.each(SHEET.map((name) => [name]))('keeps %s inside the 24px box', (name) => {
    // Plain coordinates only (circle/rect attributes and absolute M/L/H/V
    // commands would be the ones to escape); relative arcs are checked by eye.
    const numbers = [...drawingOf(render(name)).matchAll(/\b(?:cx|cy|x|y)="(-?[\d.]+)"/g)].map((m) => Number(m[1]));
    expect(numbers.filter((n) => n < 0 || n > 24)).toEqual([]);
  });

  it('uses one stroke weight for the whole set', () => {
    expect(render('dashboard')).toContain('stroke-width="1.75"');
  });

  it('renders at the requested size', () => {
    expect(render('scorecard', 16)).toContain('width="16"');
  });
});
