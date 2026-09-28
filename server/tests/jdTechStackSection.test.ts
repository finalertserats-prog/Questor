import { describe, it, expect } from 'vitest';
import { findTechStackSection, syncJdTechStack } from '../src/domain/jdTechStackSection.js';
import type { TechStackItem } from '../src/domain/techStack.js';
import { lintJd } from '../src/engines/jdDraft.js';

/**
 * The JD keeps its own words. The tech-stack section — found by heading,
 * inline or bulleted — is the only thing rewritten; everything else is left
 * exactly as it was, line endings included.
 */

const react: TechStackItem = { name: 'React', category: 'framework', level: 'strong', required: true };
const docker: TechStackItem = { name: 'Docker', category: 'platform', level: 'familiar', required: false };

const JD = 'Senior Engineer\n\nAbout the role\nYou will build things.\n\nWhat you bring\n- Curiosity\n\nWe welcome everyone.';

describe('finding the section', () => {
  it('finds a bare heading followed by bullets', () => {
    const lines = ['Intro', 'Tech stack', '- React', '- Vue', '', 'Location'];
    expect(findTechStackSection(lines)).toEqual({ start: 1, end: 4 });
  });

  it('finds a markdown heading whatever its case', () => {
    expect(findTechStackSection(['## TECHNICAL REQUIREMENTS', '* Python'])).toEqual({ start: 0, end: 2 });
  });

  it('treats an inline list as a one-line section', () => {
    expect(findTechStackSection(['Role text', 'Tech stack: React, Postgres.'])).toEqual({ start: 1, end: 2 });
  });

  it('does not take a sentence about the stack for the section', () => {
    expect(findTechStackSection(['Tech stack is modern here.', 'More prose'])).toBeNull();
  });

  it('does not take a bare heading with no list under it for the section', () => {
    expect(findTechStackSection(['Technologies', 'We use whatever fits.'])).toBeNull();
  });
});

describe('inserting', () => {
  it('appends the section after the last line', () => {
    expect(syncJdTechStack(JD, [react]).text).toBe(`${JD}\n\nTech stack\n- React: strong experience (required)`);
  });

  it('reports the insert', () => {
    expect(syncJdTechStack(JD, [react]).kind).toBe('inserted');
  });

  it('phrases a nice-to-have as such', () => {
    expect(syncJdTechStack(JD, [docker]).after).toEqual(['Tech stack', '- Docker: familiarity (nice to have)']);
  });

  it('keeps CRLF line endings', () => {
    const crlf = JD.replace(/\n/g, '\r\n');
    expect(syncJdTechStack(crlf, [react]).text).toBe(`${crlf}\r\n\r\nTech stack\r\n- React: strong experience (required)`);
  });

  it('is a no-op on a JD without a section when the stack is empty', () => {
    expect(syncJdTechStack(JD, [])).toMatchObject({ text: JD, changed: false, kind: 'unchanged' });
  });
});

describe('replacing', () => {
  const withSection = `${JD}\n\nTech stack\n- Vue: working knowledge (required)\n- Docker: familiarity (nice to have)\n\nClosing line.`;

  it('rewrites only the bullet list under the heading', () => {
    expect(syncJdTechStack(withSection, [react]).text).toBe(`${JD}\n\nTech stack\n- React: strong experience (required)\n\nClosing line.`);
  });

  it('reports what was there before', () => {
    expect(syncJdTechStack(withSection, [react]).before).toEqual(['Tech stack', '- Vue: working knowledge (required)', '- Docker: familiarity (nice to have)']);
  });

  it('replaces the inline list the catalog release wrote', () => {
    expect(syncJdTechStack(`${JD}\n\nTech stack: Vue, Docker.`, [react]).text).toBe(`${JD}\n\nTech stack\n- React: strong experience (required)`);
  });

  it('is a no-op when the section already matches', () => {
    const synced = syncJdTechStack(withSection, [react]).text;
    expect(syncJdTechStack(synced, [react])).toMatchObject({ text: synced, changed: false, kind: 'unchanged' });
  });

  it('removes the section when the stack is emptied', () => {
    expect(syncJdTechStack(withSection, []).text).toBe(`${JD}\n\nClosing line.`);
  });

  it('never touches text outside the section', () => {
    const text = syncJdTechStack(withSection, [react, docker]).text;
    expect(text.startsWith(JD) && text.endsWith('\n\nClosing line.')).toBe(true);
  });
});

describe('the lint on the result', () => {
  it('still flags exclusionary wording elsewhere in the JD', () => {
    const text = syncJdTechStack('We want a rockstar.\n', [react]).text;
    expect(lintJd(text).map((l) => l.term)).toEqual(['rockstar']);
  });
});
