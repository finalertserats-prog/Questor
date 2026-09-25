import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  listApiPath,
  nextSearchParams,
  pageButtons,
  pageRangeLabel,
  parsePage,
  parsePageSize,
  readStoredPageSize,
  totalPages,
  writeStoredPageSize,
  type SizeStore,
} from '../src/components/listPagingModel';

function memoryStore(initial: Record<string, string> = {}): SizeStore & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

const throwingStore: SizeStore = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

describe('parsePageSize', () => {
  it.each([['25', 25], ['50', 50], ['100', 100]])('accepts %s', (raw, size) => {
    expect(parsePageSize(raw)).toBe(size);
  });

  it.each(['10', '0', '1000', '-25', 'abc', '', '25.0'])('refuses %s', (raw) => {
    expect(parsePageSize(raw)).toBeNull();
  });

  it('refuses a missing value', () => {
    expect(parsePageSize(null)).toBeNull();
  });
});

describe('parsePage', () => {
  it('reads a page number', () => {
    expect(parsePage('3')).toBe(3);
  });

  it.each(['0', '-2', 'x', '', '1.5'])('falls back to 1 for %s', (raw) => {
    expect(parsePage(raw)).toBe(1);
  });
});

describe('remembered page size', () => {
  it('defaults to 25', () => {
    expect(readStoredPageSize(memoryStore(), 'candidates')).toBe(DEFAULT_PAGE_SIZE);
  });

  it('remembers each list separately', () => {
    const store = memoryStore();
    writeStoredPageSize(store, 'candidates', 100);
    expect([readStoredPageSize(store, 'candidates'), readStoredPageSize(store, 'interviews')]).toEqual([100, 25]);
  });

  it('ignores a stored size that is no longer offered', () => {
    expect(readStoredPageSize(memoryStore({ 'questor.pageSize.candidates': '10' }), 'candidates')).toBe(25);
  });

  it('falls back to the default when storage throws', () => {
    expect(readStoredPageSize(throwingStore, 'candidates')).toBe(25);
  });

  it('does not throw when storage refuses a write', () => {
    expect(() => writeStoredPageSize(throwingStore, 'candidates', 50)).not.toThrow();
  });

  it('works with no storage at all', () => {
    expect(readStoredPageSize(null, 'interviews')).toBe(25);
  });
});

describe('totalPages', () => {
  it('rounds up', () => {
    expect(totalPages(83, 25)).toBe(4);
  });

  it('is at least one page for an empty list', () => {
    expect(totalPages(0, 25)).toBe(1);
  });
});

describe('pageRangeLabel', () => {
  it('names the rows on this page', () => {
    expect(pageRangeLabel({ total: 83, page: 2, pageSize: 25 }, 'candidate')).toBe('26–50 of 83 candidates');
  });

  it('stops at the total on the last page', () => {
    expect(pageRangeLabel({ total: 83, page: 4, pageSize: 25 }, 'candidate')).toBe('76–83 of 83 candidates');
  });

  it('uses the singular for one', () => {
    expect(pageRangeLabel({ total: 1, page: 1, pageSize: 25 }, 'interview')).toBe('1–1 of 1 interview');
  });

  it('says so when there is nothing', () => {
    expect(pageRangeLabel({ total: 0, page: 1, pageSize: 25 }, 'interview')).toBe('No interviews');
  });
});

describe('pageButtons', () => {
  it('lists every page when there are few', () => {
    expect(pageButtons(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it('elides the runs between the ends and the current page', () => {
    expect(pageButtons(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
  });

  it('does not elide next to the first page', () => {
    expect(pageButtons(2, 20)).toEqual([1, 2, 3, null, 20]);
  });
});

describe('listApiPath', () => {
  it('sends page and size', () => {
    expect(listApiPath('/candidates', { page: 2, pageSize: 50 })).toBe('/candidates?page=2&pageSize=50');
  });

  it('sends a trimmed search', () => {
    expect(listApiPath('/candidates', { page: 1, pageSize: 25, q: '  ada ' })).toBe('/candidates?page=1&pageSize=25&q=ada');
  });

  it('sends extra filters that have a value', () => {
    expect(listApiPath('/interviews', { page: 1, pageSize: 25, extra: { states: 'NO_SHOW,CANCELLED', candidateId: undefined } }))
      .toBe('/interviews?page=1&pageSize=25&states=NO_SHOW%2CCANCELLED');
  });
});

describe('nextSearchParams', () => {
  it('keeps a dashboard filter while paging', () => {
    expect(nextSearchParams(new URLSearchParams('state=stopped'), { page: 3 }).toString()).toBe('state=stopped&page=3');
  });

  it('leaves page 1 out of the address', () => {
    expect(nextSearchParams(new URLSearchParams('page=4'), { page: 1 }).toString()).toBe('');
  });

  it('drops an empty search', () => {
    expect(nextSearchParams(new URLSearchParams('q=ada'), { q: ' ' }).toString()).toBe('');
  });

  it('records the page size', () => {
    expect(nextSearchParams(new URLSearchParams(), { pageSize: 100 }).toString()).toBe('pageSize=100');
  });
});
