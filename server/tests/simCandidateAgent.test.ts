import { describe, it, expect } from 'vitest';
import { cleanAnswer } from '../src/sim/candidateAgent.js';

describe('cleanAnswer', () => {
  it('takes plain prose as spoken words', () => {
    expect(cleanAnswer('I owned the ingestion pipeline for about two years.', 'A'))
      .toBe('I owned the ingestion pipeline for about two years.');
  });

  it('keeps a long prose answer that carries no JSON at all', () => {
    // The failure that motivated dropping the JSON contract: a peer returns JSON
    // for short replies and drifts to prose on long ones, and the long ones are
    // the answers worth having.
    const long = 'Two things I would suspect first: memory, because it loads the whole dataset at once, and '.repeat(6);
    expect(cleanAnswer(long, 'A')).toBe(long.trim());
  });

  it('still accepts the JSON form when a peer volunteers it', () => {
    expect(cleanAnswer('{"answer":"I led the migration."}', 'A')).toBe('I led the migration.');
  });

  it('accepts the JSON form inside a fenced block', () => {
    expect(cleanAnswer('```json\n{"answer":"I led the migration."}\n```', 'A')).toBe('I led the migration.');
  });

  it('strips a fence wrapped around plain prose', () => {
    expect(cleanAnswer('```\nI led the migration.\n```', 'A')).toBe('I led the migration.');
  });

  it('strips stage directions a model adds when it forgets it is speaking', () => {
    expect(cleanAnswer('*leans forward* I led the migration.', 'A')).toBe('I led the migration.');
  });

  it('unwraps a reply quoted as a whole, which would be read out with the quotes', () => {
    expect(cleanAnswer('"I led the migration."', 'A')).toBe('I led the migration.');
    expect(cleanAnswer('“I led the migration.”', 'A')).toBe('I led the migration.');
  });

  it('leaves quotation marks that are part of the answer alone', () => {
    const inner = 'He said "ship it" and we did.';
    expect(cleanAnswer(inner, 'A')).toBe(inner);
  });

  it('truncates below the engine cap so a turn is never refused for length', () => {
    expect(cleanAnswer('x'.repeat(9000), 'A').length).toBeLessThanOrEqual(3900);
  });

  it('throws rather than passing an empty turn to the engine', () => {
    expect(() => cleanAnswer('   ', 'Quinn')).toThrow(/Quinn/);
  });
});
