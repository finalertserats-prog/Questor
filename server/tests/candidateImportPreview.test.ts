import { describe, expect, it } from 'vitest';
import { isImportable, previewRows, type PreviewInput } from '../src/services/candidateImportPreview.js';

/**
 * The preview's verdict on each row, decided before anything is saved: ready,
 * already a candidate, needs a fix, or a repeat of someone earlier in the batch.
 */

const row = (over: Partial<PreviewInput> = {}): PreviewInput => ({
  rowKey: 'r1', fullName: 'Priya Sharma', email: 'priya@example.com', hasCv: false, readError: '', included: true, ...over,
});

const statusOf = (rows: readonly PreviewInput[], ctx: Partial<Parameters<typeof previewRows>[1]> = {}) =>
  previewRows(rows, { onRole: new Map(), known: new Map(), ...ctx }).map((r) => r.status);

describe('previewRows', () => {
  it('marks a complete new person ready', () => {
    expect(statusOf([row()])).toEqual(['ready']);
  });

  it('marks a CV that could not be read', () => {
    expect(statusOf([row({ readError: 'Could not read', hasCv: true })])).toEqual(['unreadable']);
  });

  it('marks a row with no email', () => {
    expect(statusOf([row({ email: '' })])).toEqual(['missing_email']);
  });

  it('marks a row whose email is not an address', () => {
    expect(statusOf([row({ email: 'priya at example' })])).toEqual(['invalid_email']);
  });

  it('marks a row with no name', () => {
    expect(statusOf([row({ fullName: ' ' })])).toEqual(['missing_name']);
  });

  it('marks a person already on the role, whatever the capitals', () => {
    const onRole = new Map([['priya@example.com', 'cand-1']]);

    expect(previewRows([row({ email: ' Priya@Example.COM ' })], { onRole, known: new Map() })[0]).toMatchObject({ status: 'existing', existingCandidateId: 'cand-1' });
  });

  it('marks a person seen on another role as known, to reuse', () => {
    const known = new Map([['priya@example.com', 'cand-9']]);

    expect(previewRows([row()], { onRole: new Map(), known })[0]).toMatchObject({ status: 'known', knownCandidateId: 'cand-9' });
  });

  it('prefers "already on this role" over "known elsewhere"', () => {
    const map = new Map([['priya@example.com', 'x']]);

    expect(statusOf([row()], { onRole: map, known: map })).toEqual(['existing']);
  });

  it('marks the second row with the same address a duplicate in the batch', () => {
    expect(statusOf([row(), row({ rowKey: 'r2', email: 'PRIYA@example.com' })])).toEqual(['ready', 'duplicate_in_batch']);
  });

  it('lets the second row stand once the first is unticked', () => {
    expect(statusOf([row({ included: false }), row({ rowKey: 'r2' })])).toEqual(['ready', 'ready']);
  });

  it('does not let a broken first row block a good second one', () => {
    expect(statusOf([row({ fullName: '' }), row({ rowKey: 'r2' })])).toEqual(['missing_name', 'ready']);
  });

  it('explains every status in words', () => {
    const rows = previewRows([row({ email: '' })], { onRole: new Map(), known: new Map() });

    expect(rows[0].message).toMatch(/email/i);
  });
});

describe('isImportable', () => {
  it('imports ready, known and existing rows', () => {
    expect((['ready', 'known', 'existing'] as const).every(isImportable)).toBe(true);
  });

  it('never imports a row that needs a fix', () => {
    expect((['unreadable', 'missing_email', 'invalid_email', 'missing_name', 'duplicate_in_batch'] as const).some(isImportable)).toBe(false);
  });
});
