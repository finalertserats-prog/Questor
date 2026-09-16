import { describe, expect, it } from 'vitest';
import { SAMPLE_JD, SAMPLE_ROLE_TITLE, canLoadSample, sampleDraft } from '../src/components/roleCreateModel';

/**
 * HR typed a title and a job description, pressed "Load sample JD" to see what
 * it did, and lost their description while keeping their title: the role that
 * came out was "Azure DevOps Engineer" with a data engineer's scorecard. The
 * sample is a demonstration, and it must never cost anyone their own work.
 */
describe('canLoadSample', () => {
  it('allows the sample when nothing has been typed yet', () => {
    expect(canLoadSample({ sourceText: '', title: '' })).toBe(true);
  });

  it('treats whitespace as nothing typed', () => {
    expect(canLoadSample({ sourceText: '  \n ', title: ' ' })).toBe(true);
  });

  it('refuses to replace a job description someone has written', () => {
    expect(canLoadSample({ sourceText: 'We are hiring an Azure DevOps Engineer', title: '' })).toBe(false);
  });

  it('refuses when only a title has been typed, so the title and JD cannot come apart', () => {
    expect(canLoadSample({ sourceText: '', title: 'Azure DevOps Engineer' })).toBe(false);
  });
});

describe('sampleDraft', () => {
  it('fills the title to match the sample description, so the two agree', () => {
    expect(sampleDraft().title).toBe(SAMPLE_ROLE_TITLE);
  });

  it('fills the description with the sample', () => {
    expect(sampleDraft().sourceText).toBe(SAMPLE_JD);
  });

  it('uses a title that actually appears in the sample description', () => {
    expect(SAMPLE_JD).toContain(SAMPLE_ROLE_TITLE);
  });
});
