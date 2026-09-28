import { describe, it, expect } from 'vitest';
import {
  attestationIsEnough, forTranscript, hasReadAll, markEndReached, markTurnSeen, noTurnsSeen,
  readRecordSentence, reportableIndexes, turnsReadLabel, isTranscriptNotReadError, TRANSCRIPT_NOT_READ,
} from '../src/components/review/transcriptReadGate';

/**
 * What the page reports to the server about how much of the interview the
 * reviewer was shown.
 *
 * Turns rather than scroll distance, because the gate has to be satisfiable by
 * a reviewer using a keyboard or a screen reader — neither of whom moves a
 * scrollbar — and because a percentage is not something a server can check.
 */

const ALL = [0, 1, 2, 3];

describe('marking turns as shown', () => {
  it('starts with nothing seen', () => {
    expect(reportableIndexes(noTurnsSeen('a'), ALL)).toEqual([]);
  });

  it('records a turn that was shown', () => {
    expect(reportableIndexes(markTurnSeen(noTurnsSeen('a'), 2), ALL)).toEqual([2]);
  });

  it('reports them in the transcript\'s order, not the order they were seen', () => {
    let state = noTurnsSeen('a');
    state = markTurnSeen(state, 3);
    state = markTurnSeen(state, 0);
    expect(reportableIndexes(state, ALL)).toEqual([0, 3]);
  });

  // The caller holds this in React state, so an unchanged mark must not
  // produce a new object and a changed one must.
  it('returns the same object when nothing changed', () => {
    const state = markTurnSeen(noTurnsSeen('a'), 1);
    expect(markTurnSeen(state, 1)).toBe(state);
  });

  it('returns a new object when something did', () => {
    const state = noTurnsSeen('a');
    expect(markTurnSeen(state, 1)).not.toBe(state);
  });

  it('is not read until every turn has been shown', () => {
    let state = noTurnsSeen('a');
    for (const index of [0, 1, 2]) state = markTurnSeen(state, index);
    expect(hasReadAll(state, ALL)).toBe(false);
  });

  it('is read once they all have', () => {
    let state = noTurnsSeen('a');
    for (const index of ALL) state = markTurnSeen(state, index);
    expect(hasReadAll(state, ALL)).toBe(true);
  });
});

describe('reaching the end of the transcript', () => {
  // The list is rendered whole, never virtualised, so a reader at the bottom
  // has had all of it delivered. This is what makes the gate reachable by a
  // screen reader, which reads straight through without firing a scroll event.
  it('counts everything above it', () => {
    expect(reportableIndexes(markEndReached(noTurnsSeen('a')), ALL)).toEqual(ALL);
  });

  it('satisfies the requirement', () => {
    expect(hasReadAll(markEndReached(noTurnsSeen('a')), ALL)).toBe(true);
  });

  it('reports the turns the transcript actually has, not a guessed range', () => {
    expect(reportableIndexes(markEndReached(noTurnsSeen('a')), [4, 9])).toEqual([4, 9]);
  });

  it('is satisfied by an empty transcript without anybody reaching anything', () => {
    expect(hasReadAll(noTurnsSeen('a'), [])).toBe(true);
  });
});

describe('moving to a different transcript', () => {
  it('starts again', () => {
    const state = markEndReached(noTurnsSeen('a'));
    expect(reportableIndexes(forTranscript(state, 'b'), ALL)).toEqual([]);
  });

  it('keeps what was read when the transcript is the same one', () => {
    const state = markEndReached(noTurnsSeen('a'));
    expect(forTranscript(state, 'a')).toBe(state);
  });
});

describe('what the reviewer is told', () => {
  it('counts turns rather than showing a percentage', () => {
    expect(turnsReadLabel(markTurnSeen(noTurnsSeen('a'), 0), ALL)).toBe('Read 1 of 4 turns');
  });

  it('says so plainly once it is read', () => {
    expect(turnsReadLabel(markEndReached(noTurnsSeen('a')), ALL)).toBe('Transcript read');
  });

  it('asks for the transcript when there is no record yet', () => {
    expect(readRecordSentence(null)).toContain('Read the transcript');
  });

  it('says how the requirement was met in the app', () => {
    expect(readRecordSentence({ method: 'in_app', turnsSeen: 4, turnsTotal: 4, at: '2026-09-23T10:00:00Z' }))
      .toBe('You have read this transcript (4 of 4 turns).');
  });

  it('says when it was met elsewhere', () => {
    expect(readRecordSentence({ method: 'elsewhere', turnsSeen: 0, turnsTotal: 4, at: '2026-09-23T10:00:00Z' }))
      .toContain('elsewhere');
  });
});

describe('the attestation for reading it elsewhere', () => {
  it('needs a sentence, not a word', () => {
    expect(attestationIsEnough('read it')).toBe(false);
  });

  it('accepts one that says where', () => {
    expect(attestationIsEnough('I read the downloaded transcript in full this morning.')).toBe(true);
  });

  it('does not count whitespace', () => {
    expect(attestationIsEnough('                          ')).toBe(false);
  });
});

describe('the refusal the page keys on', () => {
  it('recognises the server refusing a verdict for an unread transcript', () => {
    expect(isTranscriptNotReadError({ code: TRANSCRIPT_NOT_READ })).toBe(true);
  });

  it('does not mistake another refusal for it', () => {
    expect(isTranscriptNotReadError({ code: 'feedback_sending' })).toBe(false);
  });

  it('survives an error that is not an object at all', () => {
    expect(isTranscriptNotReadError('boom')).toBe(false);
  });
});
