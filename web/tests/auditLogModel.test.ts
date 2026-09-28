import { describe, it, expect } from 'vitest';
import { buildAuditQuery, pageCount } from '../src/components/auditLogModel';

describe('buildAuditQuery', () => {
  it('sends only page and limit when no filter is set', () => {
    expect(buildAuditQuery({ action: '', actorId: '', fromDate: '', toDate: '', page: 1, limit: 50 })).toBe('page=1&limit=50');
  });

  it('includes the action and actor filters', () => {
    const qs = new URLSearchParams(buildAuditQuery({ action: 'candidate.created', actorId: 'u1', fromDate: '', toDate: '', page: 2, limit: 25 }));
    expect([qs.get('action'), qs.get('actorId'), qs.get('page')]).toEqual(['candidate.created', 'u1', '2']);
  });

  it("starts the from-date at the viewer's local midnight", () => {
    const qs = new URLSearchParams(buildAuditQuery({ action: '', actorId: '', fromDate: '2026-01-05', toDate: '', page: 1, limit: 50 }));
    expect(qs.get('from')).toBe(new Date(2026, 0, 5).toISOString());
  });

  it("ends the to-date at the last millisecond of the viewer's local day", () => {
    const qs = new URLSearchParams(buildAuditQuery({ action: '', actorId: '', fromDate: '', toDate: '2026-01-05', page: 1, limit: 50 }));
    expect(qs.get('to')).toBe(new Date(2026, 0, 6, 0, 0, 0, -1).toISOString());
  });

  it('ignores a malformed date rather than sending an invalid filter', () => {
    const qs = new URLSearchParams(buildAuditQuery({ action: '', actorId: '', fromDate: 'nope', toDate: '', page: 1, limit: 50 }));
    expect(qs.has('from')).toBe(false);
  });
});

describe('pageCount', () => {
  it('is at least one page even with no events', () => {
    expect(pageCount(0, 50)).toBe(1);
  });

  it('rounds partial pages up', () => {
    expect(pageCount(101, 50)).toBe(3);
  });
});
