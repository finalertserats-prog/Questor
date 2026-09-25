import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ledBy, RoundRecord, type Round } from '../src/components/PipelinePanel';

/**
 * The Rounds table is where a reader finds out what a human round produced.
 *
 * Three outcomes have to be told apart on sight, because they mean opposite
 * things and an empty cell would render all three identically: nobody has
 * written the round up, the record exists but is being held back from THIS
 * reader while they interview the same candidate, and the record is there to
 * read.
 */

const BASE: Round = {
  id: 'r1', stageKey: 'gold', conductedBy: 'HUMAN', aiObserver: true, hrMayObserve: false,
  sessionId: null, interviewers: [], scheduledAt: '2026-10-08T09:00:00.000Z', status: 'COMPLETED',
};

const render = (round: Round) => renderToStaticMarkup(createElement(RoundRecord, { round }));

const NOTES = 'Traced a production incident from the page to the post-mortem.';
const WITHHELD = 'You are interviewing this candidate at this stage yourself, so another interviewer’s record stays closed.';

describe('what the Rounds table says a round left behind', () => {
  it('shows the record of a round that has been written up', () => {
    const html = render({ ...BASE, notes: NOTES, evidence: { kind: 'notes', label: 'Interviewer’s written record', detail: '' } });

    expect(html).toContain('Traced a production incident');
  });

  it('names who wrote it, so the record is attributable on sight', () => {
    const html = render({ ...BASE, notes: NOTES, recordedBy: { userId: 'u1', name: 'Priya Raman' } });

    expect(html).toContain('Recorded by Priya Raman');
  });

  // The failure this prevents: a withheld round rendering as a blank cell, and
  // a second interviewer concluding the first one found nothing worth writing.
  it('says why a withheld record is missing rather than showing an empty cell', () => {
    const html = render({ ...BASE, notes: '', notesWithheld: WITHHELD });

    expect(html).toContain('stays closed');
  });

  it('never leaks the record it is withholding', () => {
    const html = render({ ...BASE, notes: NOTES, notesWithheld: WITHHELD });

    expect(html).not.toContain('production incident');
  });

  it('says a round still to happen has nothing recorded', () => {
    const html = render({ ...BASE, status: 'SCHEDULED', notes: '', evidence: { kind: 'none', label: 'Nothing recorded yet', detail: '' } });

    expect(html).toContain('Nothing recorded yet');
  });

  // The AI round's evidence is its assessment, which lives elsewhere on the
  // page; repeating a blank here would suggest it produced nothing.
  it('leaves the AI round alone', () => {
    expect(render({ ...BASE, conductedBy: 'AI', aiObserver: false, hrMayObserve: true })).toContain('—');
  });

  it('does not claim a transcript when the round only holds a written record', () => {
    const html = render({
      ...BASE, notes: NOTES,
      evidence: { kind: 'notes', label: 'Interviewer’s written record', detail: 'Nobody agreed to an AI observer, so there is no transcript.' },
    });

    expect(html).not.toContain('and transcript');
  });
});

describe('who a round says conducted it', () => {
  it('names the Questor colleagues seated on it', () => {
    const led = ledBy({ ...BASE, panel: [{ userId: 'u1', name: 'Priya Raman', seat: 'lead' }] });

    expect(led).toBe('Priya Raman');
  });

  // An external panellist has no account, so a typed name is all there is —
  // dropping it would make the round look like it had fewer people in the room.
  it('keeps a typed name for someone with no Questor account', () => {
    const led = ledBy({
      ...BASE, interviewers: ['Client-side lead'],
      panel: [{ userId: 'u1', name: 'Priya Raman', seat: 'lead' }],
    });

    expect(led).toBe('Priya Raman, Client-side lead');
  });

  it('does not print the same person twice when they were also typed in', () => {
    const led = ledBy({
      ...BASE, interviewers: ['Priya Raman'],
      panel: [{ userId: 'u1', name: 'Priya Raman', seat: 'lead' }],
    });

    expect(led).toBe('Priya Raman');
  });

  it('falls back to a plain description when nobody was named at all', () => {
    expect(ledBy(BASE)).toBe('Human interviewer');
  });
});
