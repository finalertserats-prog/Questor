
import { describe, expect, it } from 'vitest';
import { appendTechStack, jdOriginForSubmit, nextDraftState, shouldPollDraft } from '../src/components/jdDraftModel';

describe('jdDraftModel', () => {
  it('moves through loading, pending, ready and failed states', () => {
    const loading = nextDraftState({ kind: 'idle' }, { type: 'request' });
    expect(loading).toEqual({ kind: 'loading', attempt: 0, liveMessage: 'Looking for a suggested job description.' });
    const pending = nextDraftState(loading, { type: 'pending' });
    expect(pending.kind).toBe('pending');
    expect(shouldPollDraft(pending, 30_001)).toBe(false);
    expect(nextDraftState(pending, { type: 'failed', message: 'Try again' })).toEqual({ kind: 'failed', message: 'Try again', liveMessage: 'The suggested job description is not ready.' });
    const ready = nextDraftState(pending, { type: 'ready', id: 'd1', text: 'JD', lint: [], generator: 'heuristic' });
    expect(ready).toMatchObject({ kind: 'ready', id: 'd1', text: 'JD' });
  });

  it('appends tech stack without mutating the shared draft text', () => {
    const original = 'Role\n\nAbout the role';
    expect(appendTechStack(original, ['React', 'Postgres'])).toContain('Tech stack: React, Postgres.');
    expect(original).toBe('Role\n\nAbout the role');
  });

  it('chooses the JD origin to submit', () => {
    expect(jdOriginForSubmit({ source: 'ats', sourceText: '', draftText: '', describedUsed: false })).toBe('ats');
    expect(jdOriginForSubmit({ source: 'paste', sourceText: 'Draft edited', draftText: 'Draft', describedUsed: false })).toBe('draft');
    expect(jdOriginForSubmit({ source: 'paste', sourceText: 'From description', draftText: '', describedUsed: true })).toBe('described');
    expect(jdOriginForSubmit({ source: 'paste', sourceText: 'Pasted', draftText: '', describedUsed: false })).toBe('pasted');
  });
});
