import { describe, expect, it } from 'vitest';
import {
  EMPTY_ADD_FORM,
  addPayload,
  applyCompetencyPatch,
  applyDraft,
  competencyNameProblem,
  indicatorsFromText,
  mustPassAfterPatch,
  rebalanceWeights,
  removalLabel,
  toggleMustPass,
  type EditableCompetency,
} from '../src/components/scorecard/competencyEditModel';

function competency(id: string, weight: number, patch: Partial<EditableCompetency> = {}): EditableCompetency {
  return { id, name: `Competency ${id}`, definition: '', category: 'technical', classification: 'essential', weight, requiredLevel: 2, targetLevel: 4, indicators: [], ...patch };
}

const total = (list: readonly EditableCompetency[]) => Math.round(list.filter((c) => c.classification !== 'non_scoring' && !c.retired).reduce((s, c) => s + c.weight, 0) * 100);

describe('rebalanceWeights', () => {
  it('keeps the changed weight and scales the others to fill the rest', () => {
    const next = rebalanceWeights([competency('a', 0.8), competency('b', 0.25), competency('c', 0.25)], 'a');

    expect(next.map((c) => c.weight)).toEqual([0.8, 0.1, 0.1]);
  });

  it('gives a non-scoring competency no weight', () => {
    const next = rebalanceWeights([competency('a', 0.5, { classification: 'non_scoring' }), competency('b', 0.5)]);

    expect(next.map((c) => c.weight)).toEqual([0, 1]);
  });

  it('gives a retired competency no weight', () => {
    const next = rebalanceWeights([competency('a', 0.5, { retired: true }), competency('b', 0.5)]);

    expect(next.map((c) => c.weight)).toEqual([0, 1]);
  });

  it('splits equally when nothing has weight yet', () => {
    const next = rebalanceWeights([competency('a', 0), competency('b', 0)]);

    expect(next.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });
});

describe('applyCompetencyPatch', () => {
  it('moves the other weights when one weight is typed', () => {
    const next = applyCompetencyPatch([competency('a', 0.5), competency('b', 0.5)], 'a', { weight: 0.7 });

    expect(next.map((c) => c.weight)).toEqual([0.7, 0.3]);
  });

  it('leaves the total at 100% after a classification change to non-scoring', () => {
    const next = applyCompetencyPatch([competency('a', 0.5), competency('b', 0.5)], 'a', { classification: 'non_scoring' });

    expect(total(next)).toBe(100);
  });

  it('gives a competency made scored again an equal share', () => {
    const next = applyCompetencyPatch([competency('a', 0, { classification: 'non_scoring' }), competency('b', 1)], 'a', { classification: 'preferred' });

    expect(next.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });

  it('renames without moving any weight', () => {
    const next = applyCompetencyPatch([competency('a', 0.6), competency('b', 0.4)], 'a', { name: 'Renamed' });

    expect(next.map((c) => c.weight)).toEqual([0.6, 0.4]);
  });

  it('returns a new array and leaves the original alone', () => {
    const original = [competency('a', 0.5), competency('b', 0.5)];
    applyCompetencyPatch(original, 'a', { weight: 0.9 });

    expect(original.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });
});

describe('toggleMustPass', () => {
  it('adds an id once', () => {
    expect(toggleMustPass(['a'], 'a', true)).toEqual(['a']);
  });

  it('drops an id', () => {
    expect(toggleMustPass(['a', 'b'], 'a', false)).toEqual(['b']);
  });
});

describe('mustPassAfterPatch', () => {
  it('drops a competency from must-pass when it is made non-scoring', () => {
    expect(mustPassAfterPatch(['a', 'b'], 'a', { classification: 'non_scoring' })).toEqual(['b']);
  });

  it('keeps must-pass through a rename', () => {
    expect(mustPassAfterPatch(['a', 'b'], 'a', { name: 'Renamed' })).toEqual(['a', 'b']);
  });

  it('keeps must-pass when a competency stays scored', () => {
    expect(mustPassAfterPatch(['a'], 'a', { classification: 'preferred' })).toEqual(['a']);
  });
});

describe('indicatorsFromText', () => {
  it('reads one indicator per line and drops blanks', () => {
    expect(indicatorsFromText('Sets terms\n\n  Tracks delivery  \n')).toEqual(['Sets terms', 'Tracks delivery']);
  });
});

describe('competencyNameProblem', () => {
  it('asks for a name when none is typed', () => {
    expect(competencyNameProblem([], '   ')).toBe('Give the competency a name first.');
  });

  it('refuses a name already on the scorecard, whatever the capitals', () => {
    expect(competencyNameProblem([competency('a', 1, { name: 'Vendor Management' })], 'vendor management')).toMatch(/already/);
  });

  it('lets a competency keep its own name', () => {
    expect(competencyNameProblem([competency('a', 1, { name: 'Vendor Management' })], 'Vendor Management', 'a')).toBeNull();
  });

  it('ignores a retired competency with the same name', () => {
    expect(competencyNameProblem([competency('a', 0, { name: 'Vendor Management', retired: true })], 'Vendor Management')).toBeNull();
  });
});

describe('removalLabel', () => {
  it('offers to retire a competency interviews have used', () => {
    expect(removalLabel(true).label).toBe('Retire');
  });

  it('offers to remove one they have not', () => {
    expect(removalLabel(false).label).toBe('Remove');
  });
});

describe('applyDraft', () => {
  const draft = { definition: 'Drafted.', indicators: ['One', 'Two', 'Three'], category: 'domain' as const, suggestedClassification: 'essential' as const };

  it('fills empty fields from the draft', () => {
    expect(applyDraft({ ...EMPTY_ADD_FORM, name: 'X' }, draft).definition).toBe('Drafted.');
  });

  it('keeps a definition the person already typed', () => {
    expect(applyDraft({ ...EMPTY_ADD_FORM, name: 'X', definition: 'Mine.' }, draft).definition).toBe('Mine.');
  });

  it('takes the suggested classification', () => {
    expect(applyDraft({ ...EMPTY_ADD_FORM, name: 'X' }, draft).classification).toBe('essential');
  });
});

describe('addPayload', () => {
  it('drops must-pass from a non-scoring competency', () => {
    const payload = addPayload({ ...EMPTY_ADD_FORM, name: 'X', classification: 'non_scoring', mustPass: true });

    expect(payload.mustPass).toBe(false);
  });

  it('sends a single-spaced name and one indicator per line', () => {
    const payload = addPayload({ ...EMPTY_ADD_FORM, name: '  Vendor   Management ', indicatorsText: 'A\nB' });

    expect([payload.name, payload.indicators]).toEqual(['Vendor Management', ['A', 'B']]);
  });
});
