// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProfileAsRead } from '../src/components/profile/ProfileAsRead';
import type { ProfileRead } from '../src/components/profile/profileReadModel';

/**
 * Lane 1 as it renders.
 *
 * The screen's one job is to make checking a parsed fact cost a glance. That is
 * the source tag: press it and the line from the document the candidate
 * uploaded appears — not our parsed quote, which is the redacted version and
 * would prove nothing about whether the parse was right.
 */

const CV = [
  'Meera Iyer',                                       // 1
  'meera@example.com',                                // 2
  '',                                                 // 3
  'EXPERIENCE',                                       // 4
  'Senior Data Engineer, Northwind (2021 - Present)', // 5
  'Rebuilt the nightly ETL on Airflow.',              // 6
].join('\n');

const ev = (sourceLine: number | undefined, section = 'experience', quote = 'Senior Data Engineer, Northwind') =>
  ({ line: 0, sourceLine, quote, section });

const READ: ProfileRead = {
  roles: [{
    title: 'Senior Data Engineer', employer: 'Northwind', startYear: 2021, current: true,
    months: 54, evidence: ev(5), bullets: [],
  }],
  technologies: [{ name: 'Airflow', firstYear: 2021, lastYear: 2025, evidence: [ev(6)] }],
  qualifications: [],
  scope: [],
  gaps: [],
  tenure: { roleCount: 1 },
  redaction: { linesRemoved: 2, kinds: ['name', 'contact'], injectionLines: [] },
  source: 'deterministic',
};

const panel = (over: Partial<ProfileRead> = {}, rawText = CV) =>
  render(h(ProfileAsRead, { read: { ...READ, ...over }, rawText }));

afterEach(cleanup);

describe('the profile as read', () => {
  it('opens with what the CV says, not with a score', () => {
    panel();
    expect(screen.getByText('Senior Data Engineer · Northwind')).toBeTruthy();
  });

  it('shows the real line of the document when the source tag is pressed', () => {
    panel();
    // Nothing of the document is on screen until it is asked for.
    expect(screen.queryByText(/Senior Data Engineer, Northwind \(2021 - Present\)/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'line 5' }));

    expect(screen.getByText(/Senior Data Engineer, Northwind \(2021 - Present\)/)).toBeTruthy();
  });

  it('shows the document text, not the parsed quote', () => {
    // The stored quote is the redacted reading. Showing it back would prove the
    // parser agrees with itself and nothing about whether it read the CV right.
    panel({
      roles: [{
        title: 'Senior Data Engineer', employer: 'Northwind', startYear: 2021, current: true,
        evidence: ev(5, 'experience', 'a quote that is not what the document says'), bullets: [],
      }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'line 5' }));

    expect(screen.getByText(/Senior Data Engineer, Northwind \(2021 - Present\)/)).toBeTruthy();
  });

  it('offers nothing to press when the line was never recorded', () => {
    panel({
      roles: [{
        title: 'Senior Data Engineer', employer: 'Northwind', startYear: 2021, current: true,
        evidence: ev(undefined), bullets: [],
      }],
    });

    const tag = screen.getByRole('button', { name: 'source not recorded' });
    expect((tag as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks a role whose end date could not be read, and says why', () => {
    panel({
      roles: [{
        title: 'Analyst', employer: 'Orbit', startYear: 2016, current: false,
        evidence: ev(5), bullets: [],
      }],
    });

    expect(screen.getByText(/No end date could be read/)).toBeTruthy();
  });

  it('separates a skills-list claim from experience in a role', () => {
    panel({ technologies: [{ name: 'Kafka', evidence: [ev(20, 'skills', 'Skills: Kafka')] }] });

    fireEvent.click(screen.getByRole('tab', { name: /Technologies/ }));

    expect(screen.getByText('Named in a skills list, not in any role described.')).toBeTruthy();
  });

  it('says what was taken out, so an empty section is never read as an empty CV', () => {
    panel();

    fireEvent.click(screen.getByRole('tab', { name: /Not read/ }));

    expect(screen.getByText(/2 lines removed/)).toBeTruthy();
  });

  it('names an injection attempt as found but never acted on', () => {
    panel({ redaction: { linesRemoved: 0, kinds: [], injectionLines: [30] } });

    fireEvent.click(screen.getByRole('tab', { name: /Not read/ }));

    expect(screen.getByText(/never scored/)).toBeTruthy();
  });

  it('never puts a score, a band or a percentage anywhere on the screen', () => {
    // The whole premise of Lane 1: a judgement needs a role to be judged
    // against, and this screen has not been told one.
    const { container } = panel();
    expect(container.textContent).not.toMatch(/\d+\s*%|\bscore\b|\bband\b|\bfit\b/i);
  });

  it('asks for a resume rather than rendering an empty reading', () => {
    render(h(ProfileAsRead, { read: null, rawText: '' }));
    expect(screen.getByText('No resume has been read yet')).toBeTruthy();
  });
});
