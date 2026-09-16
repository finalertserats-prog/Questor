import { describe, it, expect } from 'vitest';
import { WEIGHT_TOLERANCE_POINTS, weightsProblem, weightsTotal } from '../src/components/scorecardModel';

const comp = (classification: string, weight: number) => ({ classification, weight });

describe('weightsTotal', () => {
  it('adds the scored competencies up as whole percentage points', () => {
    expect(weightsTotal([comp('essential', 0.5), comp('preferred', 0.3), comp('trainable', 0.2)])).toBe(100);
  });

  // Non-scoring competencies carry no weight in the score, so they carry none
  // in this total either — the server excludes them the same way.
  it('leaves non-scoring competencies out of the total', () => {
    expect(weightsTotal([comp('essential', 0.6), comp('non_scoring', 0.4)])).toBe(60);
  });

  it('is zero when there is nothing to weigh', () => {
    expect(weightsTotal([])).toBe(0);
  });

  it('ignores a weight that is not a number rather than totalling NaN', () => {
    expect(weightsTotal([comp('essential', 1), comp('preferred', Number.NaN)])).toBe(100);
  });
});

describe('weightsProblem', () => {
  it('says nothing when the weights total a hundred', () => {
    expect(weightsProblem([comp('essential', 0.7), comp('preferred', 0.3)])).toBe(null);
  });

  it('allows the rounding tolerance the server allows', () => {
    expect(weightsProblem([comp('essential', 0.33), comp('preferred', 0.33), comp('trainable', 0.33)])).toBe(null);
  });

  it('states the total in the server\'s own words when it is too low', () => {
    expect(weightsProblem([comp('essential', 0.5), comp('preferred', 0.3)]))
      .toBe('Weights of the scored competencies total 80%; they must total 100%.');
  });

  it('states it the same way when the total is too high', () => {
    expect(weightsProblem([comp('essential', 0.8), comp('preferred', 0.5)]))
      .toBe('Weights of the scored competencies total 130%; they must total 100%.');
  });

  it('catches a scorecard whose weights were all moved to non-scoring rows', () => {
    expect(weightsProblem([comp('non_scoring', 1)]))
      .toBe('Weights of the scored competencies total 0%; they must total 100%.');
  });

  it('allows exactly the edge of the tolerance', () => {
    expect(weightsProblem([comp('essential', (100 - WEIGHT_TOLERANCE_POINTS) / 100)])).toBe(null);
  });

  it('refuses one point past it', () => {
    expect(weightsProblem([comp('essential', (100 - WEIGHT_TOLERANCE_POINTS - 1) / 100)])).not.toBe(null);
  });
});
