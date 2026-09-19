import { describe, it, expect } from 'vitest';
import { roleDetailLine, roleDisplayLabel, roleDisplayLabels, sessionOptionLabels } from '../src/components/roleLabelModel';

const role = (over: Partial<{ id: string; title: string; level: string | null; regionCode: string | null; experienceBand: string | null; createdAt: string | null }>) => ({
  id: 'r1', title: 'Backend Engineer', level: 'Senior', regionCode: 'IN', experienceBand: 'mid', createdAt: '2026-01-05T10:00:00Z', ...over,
});

describe('roleDisplayLabels', () => {
  it('leaves unique titles unchanged', () => {
    expect(roleDisplayLabels([role({ id: 'a', title: 'QA' }), role({ id: 'b', title: 'Design' })])).toEqual(['QA', 'Design']);
  });

  it('appends the level when it tells two same-titled roles apart', () => {
    const labels = roleDisplayLabels([role({ id: 'a', level: 'Senior' }), role({ id: 'b', level: 'Junior' })]);
    expect(labels).toEqual(['Backend Engineer · Senior', 'Backend Engineer · Junior']);
  });

  it('uses the region code when the level is the same', () => {
    const labels = roleDisplayLabels([role({ id: 'a', regionCode: 'IN' }), role({ id: 'b', regionCode: 'US' })]);
    expect(labels).toEqual(['Backend Engineer · IN', 'Backend Engineer · US']);
  });

  it('uses the experience band when level and region match', () => {
    const labels = roleDisplayLabels([role({ id: 'a', experienceBand: 'mid' }), role({ id: 'b', experienceBand: 'lead' })]);
    expect(labels).toEqual(['Backend Engineer · mid', 'Backend Engineer · lead']);
  });

  it('falls back to the creation date when nothing else differs', () => {
    const labels = roleDisplayLabels([role({ id: 'a', createdAt: '2026-01-05T10:00:00Z' }), role({ id: 'b', createdAt: '2026-03-09T10:00:00Z' })]);
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('adds a second field when the first leaves two roles still tied', () => {
    const labels = roleDisplayLabels([
      role({ id: 'a', title: 'Senior Backend Engineer (Payments)', level: 'Senior', regionCode: 'IN' }),
      role({ id: 'b', title: 'Senior Backend Engineer (Payments)', level: 'Senior', regionCode: 'US' }),
      role({ id: 'c', title: 'Senior Backend Engineer (Payments)', level: 'Staff', regionCode: 'IN' }),
    ]);
    expect(labels[0]).toBe('Senior Backend Engineer (Payments) · Senior · IN');
  });

  it('does not decorate the same role listed twice', () => {
    expect(roleDisplayLabels([role({ id: 'a' }), role({ id: 'a' })])).toEqual(['Backend Engineer', 'Backend Engineer']);
  });

  it('works before the server sends the display fields', () => {
    expect(roleDisplayLabels([{ id: 'a', title: 'QA' }, { id: 'b', title: 'QA' }])).toEqual(['QA', 'QA']);
  });

  it('only decorates the titles that collide', () => {
    const labels = roleDisplayLabels([role({ id: 'a', level: 'Senior' }), role({ id: 'b', level: 'Junior' }), role({ id: 'c', title: 'QA' })]);
    expect(labels[2]).toBe('QA');
  });

  it('treats titles differing only in case or spacing as the same title', () => {
    const labels = roleDisplayLabels([role({ id: 'a', title: 'QA ', level: 'Senior' }), role({ id: 'b', title: 'qa', level: 'Junior' })]);
    expect(labels).toEqual(['QA · Senior', 'qa · Junior']);
  });
});

describe('roleDisplayLabel', () => {
  it('labels one item in the context of a list', () => {
    const items = [role({ id: 'a', level: 'Senior' }), role({ id: 'b', level: 'Junior' })];
    expect(roleDisplayLabel(items, 'b')).toBe('Backend Engineer · Junior');
  });
});

describe('roleDetailLine', () => {
  it('shows level, domain, region and band', () => {
    expect(roleDetailLine({ level: 'Senior', domain: 'Software', regionCode: 'IN', experienceBand: 'mid' })).toBe('Senior · Software · IN · mid');
  });

  it('says the role is not in the catalog when it has no domain', () => {
    expect(roleDetailLine({ level: 'Senior', domain: null, regionCode: null, experienceBand: null })).toBe('Senior · Not linked to catalog');
  });

  it('never uses a question mark as a separator', () => {
    expect(roleDetailLine({ level: 'Senior', domain: 'Software', regionCode: 'IN', experienceBand: null })).not.toContain('?');
  });
});

describe('sessionOptionLabels', () => {
  it('adds the time so two sessions on the same day differ', () => {
    const labels = sessionOptionLabels([
      { id: 's1', createdAt: '2026-01-05T09:00:00Z', text: 'Backend Engineer' },
      { id: 's2', createdAt: '2026-01-05T15:30:00Z', text: 'Backend Engineer' },
    ]);
    expect(labels[0]).not.toBe(labels[1]);
  });
});
