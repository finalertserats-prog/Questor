import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SystemHealthPanel, SystemHealthSection } from '../src/components/SystemHealthPanel';
import type { HealthSectionView } from '../src/components/systemHealthModel';

/**
 * What the panel puts on screen. Rendered statically, so this is the markup a
 * reader gets before any interaction: problems on top, healthy checks counted
 * behind one control, and every state named in words.
 */

const section: HealthSectionView = {
  id: 'platform',
  title: 'Platform',
  checks: [
    { id: 'database', label: 'Database', status: 'ok', summary: 'Reachable; a trivial query took 4 ms.' },
    { id: 'disk', label: 'Disk space', status: 'fail', summary: '3% free.', action: 'Free space on the volume.' },
    { id: 'commit', label: 'Running build', status: 'info', summary: 'Commit abc123.' },
    { id: 'process', label: 'Server process', status: 'warn', summary: 'Using 900 MB of memory.', detail: 'Restart counts live in pm2.' },
    { id: 'draining', label: 'Accepting new interviews', status: 'ok', summary: 'Yes.' },
  ],
};

const markup = renderToStaticMarkup(createElement(SystemHealthSection, { section }));

describe('a section of checks', () => {
  it('shows the problem before the warning', () => {
    expect(markup.indexOf('Disk space')).toBeLessThan(markup.indexOf('Server process'));
  });

  it('shows the warning before the note', () => {
    expect(markup.indexOf('Server process')).toBeLessThan(markup.indexOf('Running build'));
  });

  it('puts the healthy checks after everything that needs reading', () => {
    expect(markup.indexOf('Running build')).toBeLessThan(markup.indexOf('Database'));
  });

  it('counts the healthy checks behind one control', () => {
    expect(markup).toContain('Show 2 healthy checks');
  });

  it('names each state in words, not only in colour', () => {
    expect(markup).toContain('Problem');
  });

  it('marks the failing row for the left rule', () => {
    expect(markup).toContain('data-status="fail"');
  });

  it('shows what to do about a problem', () => {
    expect(markup).toContain('Free space on the volume.');
  });

  it('shows the detail behind a warning', () => {
    expect(markup).toContain('Restart counts live in pm2.');
  });
});

describe('the panel before its first answer', () => {
  const panel = renderToStaticMarkup(createElement(SystemHealthPanel));

  it('says it is checking rather than claiming health', () => {
    expect(panel).toContain('Checking…');
  });

  it('announces the verdict to assistive technology', () => {
    expect(panel).toContain('aria-live="polite"');
  });

  it('gives the panel a heading its region is named by', () => {
    expect(panel).toContain('aria-labelledby="system-health-title"');
  });

  it('offers a button to check again', () => {
    expect(panel).toContain('<button type="button"');
  });
});
