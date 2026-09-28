import { describe, expect, it } from 'vitest';
import {
  ScorecardEditError,
  activeCompetencies,
  addCompetency,
  cleanCompetencyText,
  rebalanceWeights,
  removeCompetency,
  retireCompetency,
  scorecardWarnings,
  updateCompetency,
} from '../src/domain/scorecardEdits.js';
import { COMPETENCY_MAX_COUNT, roleSuccessProfileSchema } from '../src/domain/profileSchema.js';
import type { Competency, RoleSuccessProfile } from '../src/domain/types.js';

/**
 * HR can now add, edit and remove competencies. The weights are shares of one
 * score, so every edit has to leave the scored ones summing to 1 — and a
 * competency that an interview has already used must never vanish from the
 * record, only stop being assessed.
 */

function competency(id: string, weight: number, patch: Partial<Competency> = {}): Competency {
  return {
    id, name: `Competency ${id}`, definition: `What ${id} means`, category: 'technical', classification: 'essential',
    weight, requiredLevel: 2, targetLevel: 4, indicators: ['Shows it'], evidenceModes: ['behavioral_example'], ...patch,
  };
}

function profileWith(competencies: Competency[], mustPass: string[] = []): RoleSuccessProfile {
  return {
    roleContext: '', outcomes: [], responsibilities: [], competencies,
    scoringRules: { mustPassCompetencyIds: mustPass, notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
    redFlags: [], seniority: 'Mid',
  };
}

const NEW = { name: 'Vendor Management', definition: 'Runs vendors well.', category: 'domain' as const, classification: 'preferred' as const, indicators: ['Negotiates terms'] };

const scoredTotal = (p: RoleSuccessProfile) => Math.round(p.competencies.filter((c) => c.classification !== 'non_scoring' && !c.retired).reduce((s, c) => s + c.weight, 0) * 1000) / 1000;

describe('addCompetency', () => {
  it('gives a new scored competency an equal share and scales the others down to fit', () => {
    const next = addCompetency(profileWith([competency('a', 0.5), competency('b', 0.5)]), NEW, { id: 'c' });

    expect(next.competencies.map((c) => Math.round(c.weight * 1000) / 1000)).toEqual([0.333, 0.333, 0.334]);
  });

  it('keeps the scored weights summing to one after the add', () => {
    const next = addCompetency(profileWith([competency('a', 0.7), competency('b', 0.3)]), NEW, { id: 'c' });

    expect(scoredTotal(next)).toBe(1);
  });

  it('gives a non-scoring competency no weight and leaves the others alone', () => {
    const next = addCompetency(profileWith([competency('a', 0.7), competency('b', 0.3)]), { ...NEW, classification: 'non_scoring' }, { id: 'c' });

    expect(next.competencies.map((c) => c.weight)).toEqual([0.7, 0.3, 0]);
  });

  it('honours a requested weight and scales the rest proportionally', () => {
    const next = addCompetency(profileWith([competency('a', 0.6), competency('b', 0.4)]), { ...NEW, weight: 0.5 }, { id: 'c' });

    expect(next.competencies.map((c) => c.weight)).toEqual([0.3, 0.2, 0.5]);
  });

  it('adds the competency to the must-pass list when asked', () => {
    const next = addCompetency(profileWith([competency('a', 1)]), { ...NEW, mustPass: true }, { id: 'c' });

    expect(next.scoringRules.mustPassCompetencyIds).toEqual(['c']);
  });

  it('ignores must-pass on a non-scoring competency', () => {
    const next = addCompetency(profileWith([competency('a', 1)]), { ...NEW, classification: 'non_scoring', mustPass: true }, { id: 'c' });

    expect(next.scoringRules.mustPassCompetencyIds).toEqual([]);
  });

  it('mints an eight-character id when none is given', () => {
    const next = addCompetency(profileWith([competency('a', 1)]), NEW);

    expect(next.competencies[1].id).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  it('refuses a reserved id that the planner uses for its own blocks', () => {
    expect(() => addCompetency(profileWith([competency('a', 1)]), NEW, { id: '__process__' })).toThrow(ScorecardEditError);
  });

  it('refuses an id already on the scorecard', () => {
    expect(() => addCompetency(profileWith([competency('a', 1)]), NEW, { id: 'a' })).toThrow(/already/);
  });

  it('refuses a name already on the scorecard, whatever the capitals', () => {
    expect(() => addCompetency(profileWith([competency('a', 1, { name: 'Vendor management' })]), NEW, { id: 'b' })).toThrow(/already/);
  });

  it('refuses a forty-first competency', () => {
    const full = Array.from({ length: COMPETENCY_MAX_COUNT }, (_, i) => competency(`c${i}`, 1 / COMPETENCY_MAX_COUNT));

    expect(() => addCompetency(profileWith(full), NEW)).toThrow(/at most/);
  });

  it('does not change the profile it was given', () => {
    const original = profileWith([competency('a', 0.5), competency('b', 0.5)]);
    addCompetency(original, NEW, { id: 'c' });

    expect(original.competencies.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });

  it('produces a profile the save schema accepts', () => {
    const next = addCompetency(profileWith([competency('a', 0.5), competency('b', 0.5)]), NEW, { id: 'c' });

    expect(roleSuccessProfileSchema.safeParse(next).success).toBe(true);
  });
});

describe('updateCompetency', () => {
  it('scales the other scored weights to fill what a changed weight leaves', () => {
    const next = updateCompetency(profileWith([competency('a', 0.5), competency('b', 0.25), competency('c', 0.25)]), 'a', { weight: 0.8 });

    expect(next.competencies.map((c) => c.weight)).toEqual([0.8, 0.1, 0.1]);
  });

  it('zeroes the weight of a competency made non-scoring and redistributes it', () => {
    const next = updateCompetency(profileWith([competency('a', 0.5), competency('b', 0.5)]), 'a', { classification: 'non_scoring' });

    expect(next.competencies.map((c) => c.weight)).toEqual([0, 1]);
  });

  it('gives a competency made scored again an equal share', () => {
    const next = updateCompetency(profileWith([competency('a', 0, { classification: 'non_scoring' }), competency('b', 1)]), 'a', { classification: 'preferred' });

    expect(next.competencies.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });

  it('renames without touching the weights', () => {
    const next = updateCompetency(profileWith([competency('a', 0.6), competency('b', 0.4)]), 'a', { name: 'Renamed' });

    expect([next.competencies[0].name, next.competencies[0].weight]).toEqual(['Renamed', 0.6]);
  });

  it('drops a competency from must-pass when asked', () => {
    const next = updateCompetency(profileWith([competency('a', 1)], ['a']), 'a', { mustPass: false });

    expect(next.scoringRules.mustPassCompetencyIds).toEqual([]);
  });

  it('refuses an id that is not on the scorecard', () => {
    expect(() => updateCompetency(profileWith([competency('a', 1)]), 'zz', { name: 'X' })).toThrow(ScorecardEditError);
  });

  it('refuses to make the only scored competency non-scoring', () => {
    expect(() => updateCompetency(profileWith([competency('a', 1)]), 'a', { classification: 'non_scoring' })).toThrow(/stay scored/);
  });

  it('refuses to give a retired competency weight again', () => {
    expect(() => updateCompetency(profileWith([competency('a', 0, { retired: true }), competency('b', 1)]), 'a', { weight: 0.5 })).toThrow(/retired/);
  });
});

describe('removeCompetency', () => {
  it('redistributes the removed weight proportionally', () => {
    const next = removeCompetency(profileWith([competency('a', 0.5), competency('b', 0.3), competency('c', 0.2)]), 'a');

    expect(next.competencies.map((c) => c.weight)).toEqual([0.6, 0.4]);
  });

  it('takes the competency out of the must-pass list as well', () => {
    const next = removeCompetency(profileWith([competency('a', 0.5), competency('b', 0.5)], ['a', 'b']), 'a');

    expect(next.scoringRules.mustPassCompetencyIds).toEqual(['b']);
  });

  it('refuses to remove the last active competency', () => {
    expect(() => removeCompetency(profileWith([competency('a', 1)]), 'a')).toThrow(/last/);
  });

  it('refuses to remove the only scored competency when the rest are non-scoring', () => {
    expect(() => removeCompetency(profileWith([competency('a', 1), competency('b', 0, { classification: 'non_scoring' })]), 'a')).toThrow(/stay scored/);
  });
});

describe('retireCompetency', () => {
  it('keeps the competency on the scorecard, marked retired, at zero weight', () => {
    const next = retireCompetency(profileWith([competency('a', 0.5), competency('b', 0.5)]), 'a');

    expect(next.competencies[0]).toMatchObject({ id: 'a', retired: true, weight: 0 });
  });

  it('hands the retired weight to the competencies still assessed', () => {
    const next = retireCompetency(profileWith([competency('a', 0.5), competency('b', 0.3), competency('c', 0.2)]), 'a');

    expect(next.competencies.map((c) => c.weight)).toEqual([0, 0.6, 0.4]);
  });

  it('leaves the retired competency out of the active list', () => {
    const next = retireCompetency(profileWith([competency('a', 0.5), competency('b', 0.5)]), 'a');

    expect(activeCompetencies(next).map((c) => c.id)).toEqual(['b']);
  });

  it('refuses to retire the only scored competency', () => {
    expect(() => retireCompetency(profileWith([competency('a', 1), competency('b', 0, { classification: 'non_scoring' })]), 'a')).toThrow(/stay scored/);
  });

  it('produces a profile the save schema still accepts', () => {
    const next = retireCompetency(profileWith([competency('a', 0.5), competency('b', 0.5)], ['a']), 'a');

    expect(roleSuccessProfileSchema.safeParse(next).success).toBe(true);
  });
});

describe('rebalanceWeights', () => {
  it('splits the weight equally when every scored weight is zero', () => {
    const next = rebalanceWeights(profileWith([competency('a', 0), competency('b', 0)]));

    expect(next.competencies.map((c) => c.weight)).toEqual([0.5, 0.5]);
  });

  it('puts the rounding remainder on the largest weight so the total is exactly one', () => {
    const next = rebalanceWeights(profileWith([competency('a', 1), competency('b', 1), competency('c', 1)]));

    expect(scoredTotal(next)).toBe(1);
  });
});

describe('cleanCompetencyText', () => {
  it('folds a pasted multi-line name onto one line', () => {
    expect(cleanCompetencyText('Vendor\r\nManagement\tskills')).toBe('Vendor Management skills');
  });

  it('strips control characters that could fake a prompt boundary', () => {
    expect(cleanCompetencyText('Name\u0000\u001b[0m')).toBe('Name[0m');
  });
});

describe('scorecardWarnings', () => {
  it('names a competency whose weight is too small for the interview to reach', () => {
    const many = Array.from({ length: 12 }, (_, i) => competency(`c${i}`, i === 0 ? 0.45 : 0.05));

    expect(scorecardWarnings(profileWith(many), 20).join('\n')).toMatch(/will not be assessed/);
  });

  it('says nothing about a scorecard the plan can cover', () => {
    expect(scorecardWarnings(profileWith([competency('a', 0.5), competency('b', 0.5)]), 45)).toEqual([]);
  });

  it('warns when more competencies are scored than the feedback letter can show', () => {
    const nine = Array.from({ length: 9 }, (_, i) => competency(`c${i}`, 1 / 9));

    expect(scorecardWarnings(profileWith(nine), 120).join('\n')).toMatch(/feedback/);
  });

  it('ignores retired competencies when counting', () => {
    const retired = Array.from({ length: 9 }, (_, i) => competency(`c${i}`, i === 0 ? 0 : 1 / 8, i === 0 ? { retired: true } : {}));

    expect(scorecardWarnings(profileWith(retired), 120)).toEqual([]);
  });
});
