import { describe, it, expect } from 'vitest';
import {
  COLUMN_LABELS,
  DEFAULT_DIRECTION,
  LEVEL_MAX,
  SORT_KEYS,
  ariaSort,
  cellLabel,
  cellStanding,
  cellTitle,
  comparisonPath,
  levelTicks,
  nextSort,
  shortlistHint,
  sortFromParams,
  sortToParams,
  type GridCell,
} from '../src/components/compare/comparisonModel';

describe('sort columns', () => {
  it('offers the keys the server sorts by', () => {
    expect([...SORT_KEYS]).toEqual(['verdict', 'score', 'stage', 'recency', 'name']);
  });

  it('labels every column it offers', () => {
    expect(SORT_KEYS.every((key) => COLUMN_LABELS[key].length > 0)).toBe(true);
  });
});

describe('nextSort', () => {
  it('opens a new column at the end a manager is looking for', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'score')).toEqual({ key: 'score', dir: 'desc' });
  });

  it('opens the name column at A', () => {
    expect(nextSort({ key: 'score', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('reverses a column that is already the sort', () => {
    expect(nextSort({ key: 'score', dir: 'desc' }, 'score')).toEqual({ key: 'score', dir: 'asc' });
  });

  it('reverses back again', () => {
    expect(nextSort({ key: 'score', dir: 'asc' }, 'score')).toEqual({ key: 'score', dir: 'desc' });
  });
});

describe('ariaSort', () => {
  it('names the direction of the active column', () => {
    expect(ariaSort({ key: 'score', dir: 'desc' }, 'score')).toBe('descending');
  });

  it('says nothing about a column that is not the sort', () => {
    expect(ariaSort({ key: 'score', dir: 'desc' }, 'name')).toBeUndefined();
  });
});

describe('the sort in the address', () => {
  it('reads the sort from the address', () => {
    expect(sortFromParams(new URLSearchParams('sort=verdict&dir=asc'))).toEqual({ key: 'verdict', dir: 'asc' });
  });

  it('falls back to the default for a key it does not offer', () => {
    expect(sortFromParams(new URLSearchParams('sort=salary')).key).toBe('recency');
  });

  it('falls back to the default for a direction it does not understand', () => {
    expect(sortFromParams(new URLSearchParams('sort=score&dir=sideways')).dir).toBe('desc');
  });

  it('sends the sort to the server as query parameters', () => {
    expect(sortToParams({ key: 'stage', dir: 'asc' })).toEqual({ sort: 'stage', dir: 'asc' });
  });
});

describe('a grid cell', () => {
  it('reads a level as its number', () => {
    expect(cellLabel({ kind: 'level', level: 4 })).toBe('4');
  });

  it('says there is no evidence in words, never as a zero', () => {
    expect(cellLabel({ kind: 'no_evidence' })).toBe('No evidence');
  });

  it('says a competency was never put to this candidate', () => {
    expect(cellLabel({ kind: 'not_assessed' })).toBe('Not assessed');
  });

  it('never renders a zero for any cell', () => {
    const cells: GridCell[] = [{ kind: 'no_evidence' }, { kind: 'not_assessed' }, { kind: 'level', level: 1 }];
    expect(cells.map(cellLabel)).not.toContain('0');
  });

  it('explains a level against what the role asks for', () => {
    expect(cellTitle({ kind: 'level', level: 5 }, 'Data modelling', 3)).toContain('Data modelling');
  });

  it('says the interview found nothing to grade rather than implying a low score', () => {
    expect(cellTitle({ kind: 'no_evidence' }, 'Data modelling', 3).toLowerCase()).toContain('did not');
  });
});

describe('cellStanding', () => {
  it('marks a level above what the role asks for', () => {
    expect(cellStanding(5, 3)).toBe('above');
  });

  it('marks a level that meets it', () => {
    expect(cellStanding(3, 3)).toBe('meets');
  });

  it('marks a level below it', () => {
    expect(cellStanding(1, 3)).toBe('below');
  });

  it('has nothing to say when the role states no required level', () => {
    expect(cellStanding(4, 0)).toBeNull();
  });
});

describe('levelTicks', () => {
  it('draws one mark per point of the scale', () => {
    expect(levelTicks(3)).toHaveLength(LEVEL_MAX);
  });

  it('fills as many marks as the level', () => {
    expect(levelTicks(3).filter(Boolean)).toHaveLength(3);
  });

  it('fills nothing for a level of none', () => {
    expect(levelTicks(0).filter(Boolean)).toHaveLength(0);
  });
});

describe('shortlistHint', () => {
  it('asks for a second candidate when only one is ticked', () => {
    expect(shortlistHint(1, 4)).toContain('one more');
  });

  it('says nothing is ticked yet', () => {
    expect(shortlistHint(0, 4).toLowerCase()).toContain('tick');
  });

  it('says the comparison is ready at two', () => {
    expect(shortlistHint(2, 4).toLowerCase()).toContain('compare');
  });

  it('says the list is full at the limit', () => {
    expect(shortlistHint(4, 4).toLowerCase()).toContain('full');
  });
});

describe('comparisonPath', () => {
  it('asks the server for the chosen candidates', () => {
    expect(comparisonPath('role1', ['a', 'b'])).toBe('/roles/role1/candidates/comparison?ids=a%2Cb');
  });

  it('escapes a role id rather than pasting it into the path', () => {
    expect(comparisonPath('a/b', ['x', 'y'])).toContain('a%2Fb');
  });
});
