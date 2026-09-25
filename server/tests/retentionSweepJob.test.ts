import { describe, it, expect } from 'vitest';
import { retentionSweepRunNote, type PurgeResult } from '../src/services/dataRights.js';

/**
 * What the retention-sweep job records for a run. A sweep that failed to purge
 * rows used to finish ok=true with a note of what it did delete, so the
 * operator alert never fired and the health view read "Last succeeded" while
 * personal data stayed past its window.
 */

const result = (over: Partial<PurgeResult>): PurgeResult => ({
  sessionsPurged: 0, candidatesPurged: 0, artifactsPurged: 0, failed: 0, failures: [], deleted: {}, ...over,
});

describe('the retention sweep run note', () => {
  it('records what was deleted when every row purged', () => {
    expect(retentionSweepRunNote(result({ deleted: { sessions: 2 } }))).toBe('{"sessions":2}');
  });

  it('fails the run when any row could not be purged', () => {
    expect(() => retentionSweepRunNote(result({ failed: 2, failures: ['s1', 's2'] }))).toThrow(/2 rows could not be purged/);
  });

  it('names the rows that survived, so they can be chased', () => {
    expect(() => retentionSweepRunNote(result({ failed: 1, failures: ['session-abc'] }))).toThrow(/session-abc/);
  });
});
