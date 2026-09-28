import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SORT_KEYS, DEFAULT_DIRECTION, cellStanding, gridCell } from '../src/domain/candidateComparison.js';

/**
 * The role page's comparison, said the same way on both sides.
 *
 * The browser cannot import from the server workspace, so it carries a copy of
 * the sort keys, the default directions and the cell vocabulary. A copy that
 * drifts is how one screen ends up sorting by a key the server refuses, or
 * printing a cell the server never sends — so the two are compared as text
 * rather than trusted to stay in step.
 */

const WEB = join(__dirname, '..', '..', 'web', 'src', 'components', 'compare', 'comparisonModel.ts');
const SERVER = join(__dirname, '..', 'src', 'domain', 'candidateComparison.ts');

const web = readFileSync(WEB, 'utf8');
const server = readFileSync(SERVER, 'utf8');

function list(source: string, name: string): string[] {
  const body = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function pairs(source: string, table: string): string[] {
  const body = new RegExp(`${table}[^=]*=\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => `${m[1]}=${m[2]}`).sort();
}

function cellKinds(source: string): string[] {
  return [...source.matchAll(/kind:\s*'(level|no_evidence|not_assessed)'/g)].map((m) => m[1]).sort();
}

describe('the sort keys', () => {
  it('are the same list on both sides', () => {
    expect(list(web, 'SORT_KEYS')).toEqual(list(server, 'SORT_KEYS'));
  });

  it('are the list the server actually offers', () => {
    expect(list(server, 'SORT_KEYS')).toEqual([...SORT_KEYS]);
  });

  it('open in the same direction on both sides', () => {
    expect(pairs(web, 'DEFAULT_DIRECTION')).toEqual(pairs(server, 'DEFAULT_DIRECTION'));
    expect(pairs(web, 'DEFAULT_DIRECTION')).not.toEqual([]);
  });

  it('start every column but the name at the strongest value', () => {
    expect(Object.entries(DEFAULT_DIRECTION).filter(([, dir]) => dir === 'asc')).toEqual([['name', 'asc']]);
  });
});

describe('the grid cell vocabulary', () => {
  it('uses the same three kinds on both sides', () => {
    expect([...new Set(cellKinds(web))]).toEqual([...new Set(cellKinds(server))]);
  });

  it('never has a fourth kind the browser could not render', () => {
    expect([...new Set(cellKinds(server))]).toEqual(['level', 'no_evidence', 'not_assessed']);
  });

  it('agrees on how a level stands against what the role asks for', () => {
    expect([cellStanding(5, 3), cellStanding(3, 3), cellStanding(1, 3), cellStanding(3, 0)])
      .toEqual(['above', 'meets', 'below', null]);
  });

  it('never produces a zero for a cell', () => {
    expect(gridCell({ level: 0, notEnoughEvidence: false })).toEqual({ kind: 'no_evidence' });
  });
});
