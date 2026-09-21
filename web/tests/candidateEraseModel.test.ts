import { describe, it, expect } from 'vitest';
import { eraseOthersLabel, eraseOutcome, eraseRequestBody } from '../src/components/candidateEraseModel';

describe('eraseOthersLabel', () => {
  it('counts one other application in the singular', () => {
    expect(eraseOthersLabel(1)).toBe('Also erase their 1 other application');
  });

  it('counts several in the plural', () => {
    expect(eraseOthersLabel(3)).toBe('Also erase their 3 other applications');
  });
});

describe('eraseRequestBody', () => {
  it('asks for every application only when the box is ticked', () => {
    expect(eraseRequestBody(' Asked to be forgotten. ', true)).toEqual({ reason: 'Asked to be forgotten.', allApplications: true });
  });

  it('asks for this application alone otherwise', () => {
    expect(eraseRequestBody('Asked to be forgotten.', false)).toEqual({ reason: 'Asked to be forgotten.' });
  });
});

describe('eraseOutcome', () => {
  it('reports a single erasure', () => {
    expect(eraseOutcome({ erased: true })).toEqual({ gone: true, text: 'Candidate erased.' });
  });

  it('reports how many applications went', () => {
    expect(eraseOutcome({ erased: true, erasedCount: 3, skippedCount: 0 })).toEqual({ gone: true, text: 'Erased 3 applications.' });
  });

  it('says how many were kept under legal hold', () => {
    expect(eraseOutcome({ erased: true, erasedCount: 2, skippedCount: 1 }).text).toBe('Erased 2 applications. 1 application is under legal hold and was kept.');
  });

  it('says this application stays when it is the one held', () => {
    expect(eraseOutcome({ erased: false, erasedCount: 1, skippedCount: 1 })).toEqual({ gone: false, text: 'Erased 1 application. 1 application is under legal hold and was kept, including this one.' });
  });

  it('asks for a retry when some applications could not be erased', () => {
    expect(eraseOutcome({ erased: false, erasedCount: 1, skippedCount: 0, failedCount: 2 })).toEqual({
      gone: false, text: 'Erased 1 application. 2 applications could not be erased, so this one was kept. Erase again to finish.',
    });
  });
});
