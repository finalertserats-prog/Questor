import { describe, it, expect } from 'vitest';
import { missingRoleFields } from '../src/components/catalogModel';

const ready = { domainId: 'd1', experienceBand: 'senior', regionCode: 'IN', source: 'paste' as const, sourceReady: true };

describe('missingRoleFields', () => {
  it('lists nothing when the form is ready', () => {
    expect(missingRoleFields(ready)).toEqual([]);
  });

  it('names every missing catalog field', () => {
    expect(missingRoleFields({ ...ready, domainId: '', experienceBand: '', regionCode: '' })).toEqual(['a domain', 'an experience band', 'a region']);
  });

  it('asks for the job description when pasting', () => {
    expect(missingRoleFields({ ...ready, sourceReady: false })).toEqual(['the job description']);
  });

  it('asks for a valid requisition id when importing', () => {
    expect(missingRoleFields({ ...ready, source: 'ats', sourceReady: false })).toEqual(['a valid ATS requisition id']);
  });
});
