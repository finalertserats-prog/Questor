import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/client';
import {
  addCandidateBlocker,
  importNotice,
  importPayload,
  resumeUploadMessage,
  type AddCandidateForm,
} from '../src/components/candidateImportModel';

/**
 * Add Candidate starts either from typed details or from the organisation's
 * ATS. These are the rules the page is thin over: when it may submit, what it
 * sends, and what it says when the person is already here or a resume fails.
 */

function form(over: Partial<AddCandidateForm> = {}): AddCandidateForm {
  return {
    source: 'manual', roleId: 'role-1', fullName: 'Asha Rao', email: 'asha@example.com',
    externalCandidateId: '', hasFile: false, resumeText: 'Ten years of data engineering.', ...over,
  };
}

describe('addCandidateBlocker, typed details', () => {
  it('allows a complete form', () => {
    expect(addCandidateBlocker(form())).toBeNull();
  });

  it('asks for a role first', () => {
    expect(addCandidateBlocker(form({ roleId: '' }))).toMatch(/role/i);
  });

  it('asks for a name and an email', () => {
    expect(addCandidateBlocker(form({ email: '' }))).toMatch(/name and email/i);
  });

  it('asks for a resume', () => {
    expect(addCandidateBlocker(form({ resumeText: '   ' }))).toMatch(/resume/i);
  });

  it('accepts a file in place of pasted text', () => {
    expect(addCandidateBlocker(form({ resumeText: '', hasFile: true }))).toBeNull();
  });
});

describe('addCandidateBlocker, from the ATS', () => {
  const ats = (over: Partial<AddCandidateForm> = {}) =>
    form({ source: 'ats', fullName: '', email: '', resumeText: '', externalCandidateId: 'CAND-1042', ...over });

  it('needs no name, email or resume: the ATS supplies the contact and the resume can follow', () => {
    expect(addCandidateBlocker(ats())).toBeNull();
  });

  it('asks for the ATS candidate id', () => {
    expect(addCandidateBlocker(ats({ externalCandidateId: '  ' }))).toMatch(/candidate id/i);
  });

  it('refuses an id the server would refuse', () => {
    expect(addCandidateBlocker(ats({ externalCandidateId: 'CAND 1042/../x' }))).toMatch(/letters, numbers/i);
  });

  it('still asks for a role', () => {
    expect(addCandidateBlocker(ats({ roleId: '' }))).toMatch(/role/i);
  });
});

describe('importPayload', () => {
  it('sends only the id and the role, trimmed', () => {
    expect(importPayload(form({ source: 'ats', externalCandidateId: '  CAND-7 ' }))).toEqual({ externalCandidateId: 'CAND-7', roleId: 'role-1' });
  });
});

describe('importNotice', () => {
  it('says nothing for a fresh import', () => {
    expect(importNotice({ candidate: { id: 'c1', fullName: 'Asha Rao' }, alreadyImported: false })).toBeNull();
  });

  it('names the person who was already imported', () => {
    expect(importNotice({ candidate: { id: 'c1', fullName: 'Asha Rao' }, alreadyImported: true })).toMatch(/Asha Rao was already imported/);
  });

  it('says a resume given with a repeat import was not uploaded, rather than dropping it silently', () => {
    expect(importNotice({ candidate: { id: 'c1', fullName: 'Asha Rao' }, alreadyImported: true }, { withResume: true }))
      .toMatch(/resume you added was not uploaded/i);
  });

  it('says the person is already on the role when the match was their address', () => {
    expect(importNotice({ candidate: { id: 'c1', fullName: 'Asha Rao' }, alreadyImported: true, matchedBy: 'email' }))
      .toBe('Asha Rao is already a candidate for this role, so nothing new was created.');
  });

  it('does not mention a resume nobody gave', () => {
    expect(importNotice({ candidate: { id: 'c1', fullName: 'Asha Rao' }, alreadyImported: true })).not.toMatch(/resume/i);
  });
});

describe('resumeUploadMessage', () => {
  it('explains an unreadable file', () => {
    expect(resumeUploadMessage(new ApiError(422, 'bad pdf'))).toMatch(/could not read that resume file/i);
  });

  it('passes other refusals through', () => {
    expect(resumeUploadMessage(new ApiError(403, 'No access to this candidate.'))).toBe('No access to this candidate.');
  });

  it('has words for something that is not an error at all', () => {
    expect(resumeUploadMessage('boom')).toMatch(/resume/i);
  });
});
