import { describe, it, expect } from 'vitest';
import {
  ATTESTATION_MAX, ATTESTATION_MIN, checkReadReport, readRefusalMessage, unseenIndexes, type ReadReport,
} from '../src/domain/transcriptRead.js';

/**
 * What "the transcript was read" means, as arithmetic.
 *
 * The definition is turns, not scroll distance, and that choice is the point:
 * a percentage is a fact about a scrollbar, so a reviewer using a keyboard or
 * a screen reader would fail a scroll test having read every word. Turns are
 * what the transcript IS, and every way of reading reaches them.
 */

const inApp = (seenIndexes: readonly number[]): ReadReport => ({ method: 'in_app', seenIndexes, attestation: '' });
const elsewhere = (attestation: string): ReadReport => ({ method: 'elsewhere', seenIndexes: [], attestation });

describe('which turns are still unseen', () => {
  it('is empty when every turn was shown', () => {
    expect(unseenIndexes([0, 1, 2], [0, 1, 2])).toEqual([]);
  });

  it('names the turns that were not, in order', () => {
    expect(unseenIndexes([0, 1, 2, 3], [3, 0])).toEqual([1, 2]);
  });

  // Indexes are unique per session, but a client that reports one twice has
  // still shown it once; a set, not a count, is what decides this.
  it('ignores a repeated report of the same turn', () => {
    expect(unseenIndexes([0, 1], [0, 0, 1])).toEqual([]);
  });

  // The index is the transcript's canonical order and it is not guaranteed to
  // start at zero once a session has been edited, so the check is membership.
  it('compares the indexes that exist, not a range', () => {
    expect(unseenIndexes([4, 9], [4, 9])).toEqual([]);
  });

  it('does not accept turns that are not in the transcript as cover for ones that are', () => {
    expect(unseenIndexes([0, 1], [7, 8, 9])).toEqual([0, 1]);
  });
});

describe('reading it in the app', () => {
  it('is satisfied by a report covering the whole conversation', () => {
    expect(checkReadReport(inApp([0, 1, 2]), [0, 1, 2])).toEqual({ ok: true });
  });

  it('refuses a report that stops short, and says how far short', () => {
    expect(checkReadReport(inApp([0]), [0, 1, 2])).toMatchObject({ ok: false, reason: 'incomplete', unseen: [1, 2], total: 3 });
  });

  it('refuses a client that claims to have read without naming a turn', () => {
    expect(checkReadReport(inApp([]), [0])).toMatchObject({ ok: false, reason: 'incomplete' });
  });

  // Not a loophole worth closing here: the record is still required, still
  // names the reviewer, and is still audited. What it is not is a reason to
  // strand someone in front of an empty conversation with a dead button.
  it('accepts a transcript that has no turns', () => {
    expect(checkReadReport(inApp([]), [])).toEqual({ ok: true });
  });
});

describe('reading it elsewhere', () => {
  it('is satisfied by a reviewer who says where they read it', () => {
    expect(checkReadReport(elsewhere('I read the downloaded transcript in full before writing this.'), [0, 1])).toEqual({ ok: true });
  });

  it('does not need the turns to have been shown in the app', () => {
    expect(checkReadReport(elsewhere('Read the exported PDF end to end on the flight.'), [0, 1, 2, 3])).toEqual({ ok: true });
  });

  it('refuses an empty attestation', () => {
    expect(checkReadReport(elsewhere(''), [])).toEqual({ ok: false, reason: 'no_attestation' });
  });

  it('refuses one too short to mean anything', () => {
    expect(checkReadReport(elsewhere('read it'), [])).toEqual({ ok: false, reason: 'no_attestation' });
  });

  // Bounded in the rule, not only in the route's schema: the rule is what
  // decides whether the requirement was met, and it should not depend on every
  // future caller remembering a second check.
  it('refuses one longer than the column will hold', () => {
    expect(checkReadReport(elsewhere('x'.repeat(ATTESTATION_MAX + 1)), [])).toEqual({ ok: false, reason: 'no_attestation' });
  });

  it('accepts one exactly at the limit', () => {
    expect(checkReadReport(elsewhere('x'.repeat(ATTESTATION_MAX)), [])).toEqual({ ok: true });
  });

  it('does not count surrounding whitespace towards the sentence', () => {
    expect(checkReadReport(elsewhere(`${' '.repeat(ATTESTATION_MIN)}ok`), [])).toEqual({ ok: false, reason: 'no_attestation' });
  });
});

describe('what the reviewer is told', () => {
  it('counts the turns rather than reporting a failure', () => {
    const refusal = checkReadReport(inApp([0]), [0, 1, 2, 3]);
    expect(readRefusalMessage(refusal as Extract<typeof refusal, { ok: false }>))
      .toContain('4 turns and 1 of them have been shown');
  });

  it('offers the other path rather than leaving a dead end', () => {
    const refusal = checkReadReport(inApp([]), [0]);
    expect(readRefusalMessage(refusal as Extract<typeof refusal, { ok: false }>)).toContain('read it elsewhere');
  });

  it('says how long an attestation has to be', () => {
    const refusal = checkReadReport(elsewhere(''), []);
    expect(readRefusalMessage(refusal as Extract<typeof refusal, { ok: false }>)).toContain(String(ATTESTATION_MIN));
  });
});
